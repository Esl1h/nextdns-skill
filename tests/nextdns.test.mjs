import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "nextdns.mjs",
);

// Start a mock API on an ephemeral port, record every request, and hand the
// port to the test. `respond(request)` returns { status, json }.
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
      const r = respond(request) ?? { status: 200, json: {} };
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(r.json === undefined ? "" : JSON.stringify(r.json));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(server.address().port, seen);
  } finally {
    server.close();
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
