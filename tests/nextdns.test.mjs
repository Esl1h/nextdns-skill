import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "nextdns.mjs",
);

// Start a mock API on an ephemeral port, record every request, and hand the
// port to the test. `respond(request, res, port)` returns { status, json },
// or writes the response itself and returns { raw: true } (SSE, files).
async function withApi(respond, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const request = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(request);
      const r = respond(request, res, server.address().port, req) ?? { status: 200, json: {} };
      if (r.raw) return;
      res.statusCode = r.status;
      for (const [name, value] of Object.entries(r.headers ?? {})) res.setHeader(name, value);
      if (r.json === undefined && r.text !== undefined) {
        res.setHeader("content-type", "text/csv");
        res.end(r.text);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(r.json === undefined ? "" : JSON.stringify(r.json));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(server.address().port, seen);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// Async spawn on purpose: the mock server lives in this process, so the event
// loop must keep running while the CLI child talks to it. spawnSync would
// block the loop and deadlock against the server.
function runCli(args, port, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        NEXTDNS_API_URL: `http://127.0.0.1:${port}`,
        NEXTDNS_API_KEY: "test-key",
        NEXTDNS_PROFILE: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += String(error);
    });
    child.on("close", (code, signal) => {
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

// Write Server-sent events and keep the stream open until the client leaves.
function sseRespond(eventCount) {
  return (request, res, port, req) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("error", () => {});
    for (let i = 1; i <= eventCount; i += 1) {
      res.write(`id: ev${i}\ndata: ${JSON.stringify({ domain: `d${i}.com`, status: "blocked" })}\n\n`);
    }
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        res.end();
      }
    };
    req.on("close", end);
    setTimeout(end, 4000); // safety: never hold the test suite open
    return { raw: true };
  };
}

test("profiles sends the API key and prints the response", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [{ id: "abc123", name: "Home" }] } }),
    async (port, seen) => {
      const result = await runCli(["profiles"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, "GET");
      assert.equal(seen[0].url, "/profiles");
      assert.equal(seen[0].headers["x-api-key"], "test-key");
      assert.deepEqual(JSON.parse(result.stdout).data, [{ id: "abc123", name: "Home" }]);
    },
  );
});

test("logs maps filters to query parameters", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [] } }),
    async (port, seen) => {
      const result = await runCli(
        ["logs", "abc123", "--search", "facebook.com", "--status", "blocked", "--from", "-24h", "--limit", "50", "--raw"],
        port,
      );
      assert.equal(result.status, 0);
      const url = new URL(seen[0].url, "http://api");
      assert.equal(url.pathname, "/profiles/abc123/logs");
      assert.equal(url.searchParams.get("search"), "facebook.com");
      assert.equal(url.searchParams.get("status"), "blocked");
      assert.equal(url.searchParams.get("from"), "-24h");
      assert.equal(url.searchParams.get("limit"), "50");
      assert.equal(url.searchParams.get("raw"), "1");
    },
  );
});

test("logs falls back to NEXTDNS_PROFILE when the argument is omitted", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [] } }),
    async (port, seen) => {
      const result = await runCli(["logs"], port, { NEXTDNS_PROFILE: "abc123" });
      assert.equal(result.status, 0);
      assert.equal(seen[0].url, "/profiles/abc123/logs");
    },
  );
});

test("deny with only a domain and no --profile is a usage error, not a guess", async () => {
  await withApi(
    () => ({ status: 200, json: {} }),
    async (port, seen) => {
      const result = await runCli(["deny", "bad.com"], port, { NEXTDNS_PROFILE: "abc123" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /usage: nextdns deny/);
      assert.equal(seen.length, 0);
    },
  );
});

test("deny posts each domain to the denylist", async () => {
  await withApi(
    (req) => ({ status: 201, json: { data: { id: req.body.id, active: true } } }),
    async (port, seen) => {
      const result = await runCli(["deny", "abc123", "bad.com", "worse.com"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 2);
      assert.deepEqual(seen.map((r) => r.method), ["POST", "POST"]);
      assert.equal(seen[0].url, "/profiles/abc123/denylist");
      assert.deepEqual(seen[0].body, { id: "bad.com" });
      assert.deepEqual(seen[1].body, { id: "worse.com" });
      const output = JSON.parse(result.stdout);
      assert.equal(output.length, 2);
      assert.deepEqual(output[0].data, { id: "bad.com", active: true });
    },
  );
});

test("deny rejects URLs and paths before any request", async () => {
  await withApi(
    () => ({ status: 201, json: {} }),
    async (port, seen) => {
      const result = await runCli(
        ["deny", "abc123", "ok.com", "https://bad.com/x", "evil.com:443"],
        port,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not a bare domain: https:\/\/bad\.com\/x, evil\.com:443/);
      assert.equal(seen.length, 0);
    },
  );
});

test("allow works with --profile instead of a profile argument", async () => {
  await withApi(
    (req) => ({ status: 201, json: { data: { id: req.body.id } } }),
    async (port, seen) => {
      const result = await runCli(["allow", "--profile", "abc123", "good.com"], port);
      assert.equal(result.status, 0);
      assert.equal(seen[0].url, "/profiles/abc123/allowlist");
      assert.deepEqual(seen[0].body, { id: "good.com" });
    },
  );
});

test("deny-remove deletes the domain and acks empty bodies", async () => {
  await withApi(
    () => ({ status: 204 }),
    async (port, seen) => {
      const result = await runCli(["deny-remove", "abc123", "bad.com"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, "DELETE");
      assert.equal(seen[0].url, "/profiles/abc123/denylist/bad.com");
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, status: 204 });
    },
  );
});

test("toggle patches an existing entry", async () => {
  await withApi(
    (req) => {
      if (req.method === "GET") {
        return { status: 200, json: { data: [{ id: "tiktok", active: true }] } };
      }
      return { status: 200, json: { data: { id: "tiktok", active: false } } };
    },
    async (port, seen) => {
      const result = await runCli(["toggle", "profiles/abc123/parentalControl/services/tiktok", "off"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].method, "GET");
      assert.equal(seen[0].url, "/profiles/abc123/parentalControl/services");
      assert.equal(seen[1].method, "PATCH");
      assert.equal(seen[1].url, "/profiles/abc123/parentalControl/services/tiktok");
      assert.deepEqual(seen[1].body, { active: false });
    },
  );
});

test("toggle posts a missing entry", async () => {
  await withApi(
    (req) => {
      if (req.method === "GET") {
        return { status: 200, json: { data: [] } };
      }
      return { status: 201, json: { data: { id: req.body.id, active: req.body.active } } };
    },
    async (port, seen) => {
      const result = await runCli(["toggle", "profiles/abc123/parentalControl/categories/minecraft", "on"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 2);
      assert.equal(seen[1].method, "POST");
      assert.equal(seen[1].url, "/profiles/abc123/parentalControl/categories");
      assert.deepEqual(seen[1].body, { id: "minecraft", active: true });
    },
  );
});

test("toggle off on a missing entry changes nothing", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [] } }),
    async (port, seen) => {
      const result = await runCli(["toggle", "profiles/abc123/parentalControl/services/tiktok", "off"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, "GET");
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, unchanged: true, id: "tiktok", active: false });
    },
  );
});

test("toggle off deletes a blocklist, which has no active flag", async () => {
  await withApi(
    (req) => (req.method === "GET"
      ? { status: 200, json: { data: [{ id: "oisd", entries: 10 }] } }
      : { status: 204 }),
    async (port, seen) => {
      const result = await runCli(["toggle", "profiles/abc123/privacy/blocklists/oisd", "off"], port);
      assert.equal(result.status, 0);
      assert.deepEqual(seen.map((r) => r.method), ["GET", "DELETE"]);
      assert.equal(seen[1].url, "/profiles/abc123/privacy/blocklists/oisd");
    },
  );
});

test("toggle on adds a missing TLD without an active flag", async () => {
  await withApi(
    (req) => (req.method === "GET"
      ? { status: 200, json: { data: [] } }
      : { status: 201, json: { data: { id: req.body.id } } }),
    async (port, seen) => {
      const result = await runCli(["toggle", "profiles/abc123/security/tlds/zip", "on"], port);
      assert.equal(result.status, 0);
      assert.equal(seen[1].method, "POST");
      assert.equal(seen[1].url, "/profiles/abc123/security/tlds");
      assert.deepEqual(seen[1].body, { id: "zip" });
    },
  );
});

test("toggle on an existing native tracker changes nothing", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [{ id: "apple" }] } }),
    async (port, seen) => {
      const result = await runCli(["toggle", "profiles/abc123/privacy/natives/apple", "on"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 1);
      assert.equal(JSON.parse(result.stdout).unchanged, true);
    },
  );
});

test("rewrites lists entries", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [{ id: "r1", name: "nas.home", content: "192.168.1.100" }] } }),
    async (port, seen) => {
      const result = await runCli(["rewrites", "abc123"], port);
      assert.equal(result.status, 0);
      assert.equal(seen[0].url, "/profiles/abc123/rewrites");
      assert.equal(JSON.parse(result.stdout).data[0].name, "nas.home");
    },
  );
});

test("rewrite posts a name/content pair", async () => {
  await withApi(
    () => ({ status: 201, json: { data: { id: "r1", name: "nas.home", content: "192.168.1.100" } } }),
    async (port, seen) => {
      const result = await runCli(["rewrite", "abc123", "nas.home", "192.168.1.100"], port);
      assert.equal(result.status, 0);
      assert.equal(seen[0].method, "POST");
      assert.equal(seen[0].url, "/profiles/abc123/rewrites");
      assert.deepEqual(seen[0].body, { name: "nas.home", content: "192.168.1.100" });
    },
  );
});

test("rewrite-remove resolves the name to an id before deleting", async () => {
  await withApi(
    (req) => {
      if (req.method === "GET") {
        return { status: 200, json: { data: [{ id: "r1", name: "nas.home", content: "192.168.1.100" }] } };
      }
      return { status: 204 };
    },
    async (port, seen) => {
      const result = await runCli(["rewrite-remove", "abc123", "nas.home"], port);
      assert.equal(result.status, 0);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].method, "GET");
      assert.equal(seen[1].method, "DELETE");
      assert.equal(seen[1].url, "/profiles/abc123/rewrites/r1");
    },
  );
});

test("rewrite-remove deletes nothing on a partial match", async () => {
  await withApi(
    () => ({ status: 200, json: { data: [{ id: "r1", name: "nas.home", content: "192.168.1.100" }] } }),
    async (port, seen) => {
      const result = await runCli(["rewrite-remove", "abc123", "nas.home", "nope.home"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no rewrite matching nope\.home/);
      assert.equal(seen.length, 1); // the GET only; no DELETE happened
    },
  );
});

test("analytics rejects an unknown metric before any request", async () => {
  await withApi(
    () => ({ status: 200, json: {} }),
    async (port, seen) => {
      const result = await runCli(["analytics", "abc123", "domain"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unknown metric 'domain'/);
      assert.equal(seen.length, 0);
    },
  );
});

test("analytics destinations requires --type before any request", async () => {
  await withApi(
    () => ({ status: 200, json: {} }),
    async (port, seen) => {
      const result = await runCli(["analytics", "abc123", "destinations"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--type countries or --type gafam/);
      assert.equal(seen.length, 0);
    },
  );
});

test("logs rejects limits below the API minimum before any request", async () => {
  await withApi(
    () => ({ status: 200, json: {} }),
    async (port, seen) => {
      const result = await runCli(["logs", "abc123", "--limit", "5"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /between 10 and 1000/);
      assert.equal(seen.length, 0);
    },
  );
});

test("analytics rejects limits above the API maximum before any request", async () => {
  await withApi(
    () => ({ status: 200, json: {} }),
    async (port, seen) => {
      const result = await runCli(["analytics", "abc123", "status", "--limit", "999"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /between 1 and 500/);
      assert.equal(seen.length, 0);
    },
  );
});

test("logs-download prints the export URL", async () => {
  await withApi(
    (req, res, port) => {
      if (req.url === "/logs.csv") {
        return { status: 200, text: "domain,status\nbad.com,blocked\n" };
      }
      return { status: 200, json: { data: { url: `http://127.0.0.1:${port}/logs.csv` } } };
    },
    async (port, seen) => {
      const result = await runCli(["logs-download", "abc123"], port);
      assert.equal(result.status, 0);
      const url = new URL(seen[0].url, "http://api");
      assert.equal(url.pathname, "/profiles/abc123/logs/download");
      assert.equal(url.searchParams.get("redirect"), "0");
      assert.match(JSON.parse(result.stdout).data.url, /\/logs\.csv$/);
    },
  );
});

test("logs-download --out saves the CSV file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextdns-test-"));
  const out = join(dir, "logs.csv");
  try {
    await withApi(
      (req, res, port) => {
        if (req.url === "/logs.csv") {
          return { status: 200, text: "domain,status\nbad.com,blocked\n" };
        }
        return { status: 200, json: { data: { url: `http://127.0.0.1:${port}/logs.csv` } } };
      },
      async (port, seen) => {
        const result = await runCli(["logs-download", "abc123", "--out", out], port);
        assert.equal(result.status, 0);
        assert.equal(seen.length, 2);
        assert.equal(seen[1].url, "/logs.csv");
        const saved = JSON.parse(result.stdout);
        assert.equal(saved.saved, out);
        assert.equal(saved.bytes, readFileSync(out, "utf8").length);
        assert.match(readFileSync(out, "utf8"), /bad\.com,blocked/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs-download --out refuses to overwrite before any request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextdns-test-"));
  const out = join(dir, "logs.csv");
  writeFileSync(out, "keep me");
  try {
    await withApi(
      () => ({ status: 200, json: {} }),
      async (port, seen) => {
        const result = await runCli(["logs-download", "abc123", "--out", out], port);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /already exists/);
        assert.equal(seen.length, 0);
        assert.equal(readFileSync(out, "utf8"), "keep me");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear-logs deletes the log endpoint", async () => {
  await withApi(
    () => ({ status: 204 }),
    async (port, seen) => {
      const result = await runCli(["clear-logs", "abc123"], port);
      assert.equal(result.status, 0);
      assert.equal(seen[0].method, "DELETE");
      assert.equal(seen[0].url, "/profiles/abc123/logs");
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, status: 204 });
    },
  );
});

test("rate limits print the Retry-After hint", async () => {
  await withApi(
    () => ({
      status: 429,
      headers: { "retry-after": "30" },
      json: { errors: [{ code: "rate_limited" }] },
    }),
    async (port) => {
      const result = await runCli(["get", "profiles/abc123"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /HTTP 429/);
      assert.match(result.stderr, /Retry-After/);
      assert.match(result.stderr, /rate limited/);
    },
  );
});

test("patch sends the parsed JSON body", async () => {
  await withApi(
    () => ({ status: 200, json: { data: { cnameFlattening: true } } }),
    async (port, seen) => {
      const result = await runCli(["patch", "profiles/abc123/settings/performance", '{"cnameFlattening":true}'], port);
      assert.equal(result.status, 0);
      assert.equal(seen[0].method, "PATCH");
      assert.equal(seen[0].url, "/profiles/abc123/settings/performance");
      assert.deepEqual(seen[0].body, { cnameFlattening: true });
    },
  );
});

test("API errors go to stderr with exit code 1", async () => {
  await withApi(
    () => ({ status: 400, json: { errors: [{ code: "invalid", detail: "bad limit" }] } }),
    async (port) => {
      const result = await runCli(["get", "profiles/abc123"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /HTTP 400/);
      assert.match(result.stderr, /invalid/);
    },
  );
});

test("missing API key fails before any request", async () => {
  await withApi(
    () => ({ status: 200, json: {} }),
    async (port, seen) => {
      const result = await runCli(["profiles"], port, { NEXTDNS_API_KEY: "" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /NEXTDNS_API_KEY/);
      assert.equal(seen.length, 0);
    },
  );
});

test("logs --stream stops at --max-events and prints a resume hint", async () => {
  await withApi(
    sseRespond(3),
    async (port) => {
      const result = await runCli(["logs", "abc123", "--stream", "--max-events", "2"], port);
      assert.equal(result.status, 0);
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { id: "ev1", domain: "d1.com", status: "blocked" });
      assert.equal(JSON.parse(lines[1]).id, "ev2");
      assert.match(result.stderr, /stream ended after 2 events/);
      assert.match(result.stderr, /--id ev2/);
    },
  );
});

test("logs --stream without a bound fails before any request", async () => {
  await withApi(
    sseRespond(1),
    async (port, seen) => {
      const result = await runCli(["logs", "abc123", "--stream"], port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--max-events <n> or --duration <seconds>/);
      assert.equal(seen.length, 0);
    },
  );
});

test("logs --stream stops after --duration seconds", async () => {
  await withApi(
    sseRespond(1),
    async (port) => {
      const started = Date.now();
      const result = await runCli(["logs", "abc123", "--stream", "--duration", "1"], port);
      const elapsed = Date.now() - started;
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim().split("\n").length, 1);
      assert.match(result.stderr, /stream ended after 1 events/);
      assert.ok(elapsed < 3500, `stream ran for ${elapsed}ms`);
    },
  );
});

test("logs --stream resumes from the last event id", async () => {
  await withApi(
    sseRespond(3),
    async (port, seen) => {
      const result = await runCli(
        ["logs", "abc123", "--stream", "--max-events", "1", "--id", "ev9"],
        port,
      );
      assert.equal(result.status, 0);
      const url = new URL(seen[0].url, "http://api");
      assert.equal(url.pathname, "/profiles/abc123/logs/stream");
      assert.equal(url.searchParams.get("id"), "ev9");
      assert.equal(JSON.parse(result.stdout.trim()).id, "ev1");
    },
  );
});
