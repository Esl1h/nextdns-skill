#!/usr/bin/env node
// Thin CLI for the NextDNS API (docs: https://nextdns.github.io/api/).
// Auth: X-Api-Key header. The key lives at the bottom of
// https://my.nextdns.io/account and is read from the environment only.

import { parseArgs } from "node:util";

const DEFAULT_BASE_URL = "https://api.nextdns.io";

function fail(message) {
  process.stderr.write(`nextdns: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(
    [
      "Usage: nextdns <command> [options]",
      "",
      "Commands:",
      "  profiles                              List profiles (id, name)",
      "  get <path>                            GET any endpoint, e.g. profiles/abc123",
      "  logs <profile> [options]              Query DNS logs",
      "  analytics <profile> <metric> [options]",
      "                                        Metrics: status, domains, reasons, ips,",
      "                                        devices, protocols, queryTypes, ipVersions,",
      "                                        dnssec, encryption, destinations. Append",
      "                                        ;series to a metric for a time series",
      "  allowlist <profile>                   List allowlist entries",
      "  denylist <profile>                    List denylist entries",
      "  allow <profile> <domain>...           Add domain(s) to the allowlist",
      "  deny <profile> <domain>...            Add domain(s) to the denylist",
      "  allow-remove <profile> <domain>...    Remove domain(s) from the allowlist",
      "  deny-remove <profile> <domain>...     Remove domain(s) from the denylist",
      "  toggle <path> <on|off>                Enable or disable an array entry, e.g.",
      "                                        profiles/abc123/parentalControl/services/tiktok",
      "  patch <path> <json>                   PATCH any endpoint",
      "  post <path> [json]                    POST any endpoint",
      "  delete <path>                         DELETE any endpoint",
      "",
      "Options:",
      "  --limit <n>         Page size",
      "  --cursor <cursor>   Next page cursor from a previous response",
      "  --search <text>     Logs: filter by domain substring",
      "  --status <status>   Logs: default | error | blocked | allowed",
      "  --device <id>       Logs/analytics: one device id",
      "  --from <date>       Window start: -24h, -7d, 2026-01-01, ...",
      "  --to <date>         Window end",
      "  --sort <asc|desc>   Logs sort order (default desc)",
      "  --raw               Logs: include non-navigational queries",
      "  --type <t>          Analytics: destinations type (countries | gafam)",
      "",
      "Environment:",
      "  NEXTDNS_API_KEY     Required (bottom of https://my.nextdns.io/account)",
      "  NEXTDNS_API_URL     API base URL override (default https://api.nextdns.io)",
      "",
      "All output is JSON. Errors print the API error payload to stderr and exit 1.",
      "",
    ].join("\n"),
  );
}

// parseArgs rejects option values that start with a dash (--from -24h), but
// NextDNS dates are relative (-24h, -7d). Join them into the --from=-24h form,
// unless the next token is itself a known option (a missing value).
function normalize(rest, optionTokens) {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const next = rest[i + 1];
    if (
      optionTokens.has(token) &&
      next !== undefined &&
      next.startsWith("-") &&
      next !== "-" &&
      !optionTokens.has(next)
    ) {
      out.push(`${token}=${next}`);
      i += 1;
    } else {
      out.push(token);
    }
  }
  return out;
}

function parse(rest, options) {
  const optionTokens = new Set(Object.keys(options).map((name) => `--${name}`));
  const { values, positionals } = parseArgs({
    args: normalize(rest, optionTokens),
    options,
    allowPositionals: true,
  });
  return { values, positionals };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON for ${what}: ${error.message}`);
  }
}

async function call(method, path, { query, body } = {}) {
  const apiKey = process.env.NEXTDNS_API_KEY;
  if (!apiKey) {
    fail("NEXTDNS_API_KEY is not set. Find it at the bottom of https://my.nextdns.io/account");
  }
  const base = process.env.NEXTDNS_API_URL || DEFAULT_BASE_URL;
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    fail(`cannot reach ${url.origin}: ${error.cause?.message ?? error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null; // Non-JSON body; the status check below still applies.
    }
  }

  if (!response.ok || payload?.errors) {
    const detail = payload === null ? text : JSON.stringify(payload, null, 2);
    process.stderr.write(`nextdns: HTTP ${response.status}\n${detail}\n`);
    process.exit(1);
  }

  // Empty bodies, such as 204 from DELETE, come back as a minimal ack.
  return payload ?? { ok: true, status: response.status };
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const listOptions = {
  limit: { type: "string" },
  cursor: { type: "string" },
};

const timeOptions = {
  from: { type: "string" },
  to: { type: "string" },
};

const listEntries = (kind) => async (rest) => {
  const { values, positionals } = parse(rest, listOptions);
  const [profile] = positionals;
  if (!profile) fail(`usage: nextdns ${kind} <profile>`);
  print(
    await call("GET", `profiles/${profile}/${kind}`, {
      query: { limit: values.limit, cursor: values.cursor },
    }),
  );
};

const addEntries = (kind, label) => async (rest) => {
  const { positionals } = parse(rest, {});
  const [profile, ...domains] = positionals;
  if (!profile || domains.length === 0) {
    fail(`usage: nextdns ${label} <profile> <domain>...`);
  }
  const results = [];
  for (const domain of domains) {
    results.push(await call("POST", `profiles/${profile}/${kind}`, { body: { id: domain } }));
  }
  print(results.length === 1 ? results[0] : results);
};

const removeEntries = (kind, label) => async (rest) => {
  const { positionals } = parse(rest, {});
  const [profile, ...domains] = positionals;
  if (!profile || domains.length === 0) {
    fail(`usage: nextdns ${label} <profile> <domain>...`);
  }
  const results = [];
  for (const domain of domains) {
    results.push(
      await call("DELETE", `profiles/${profile}/${kind}/${encodeURIComponent(domain)}`),
    );
  }
  print(results.length === 1 ? results[0] : results);
};

const commands = {
  profiles: async (rest) => {
    const { values } = parse(rest, listOptions);
    print(await call("GET", "profiles", { query: { limit: values.limit, cursor: values.cursor } }));
  },

  get: async (rest) => {
    const { values, positionals } = parse(rest, listOptions);
    const [path] = positionals;
    if (!path) fail("usage: nextdns get <path>");
    print(await call("GET", path, { query: { limit: values.limit, cursor: values.cursor } }));
  },

  logs: async (rest) => {
    const { values, positionals } = parse(rest, {
      ...listOptions,
      ...timeOptions,
      search: { type: "string" },
      status: { type: "string" },
      device: { type: "string" },
      sort: { type: "string" },
      raw: { type: "boolean" },
    });
    const [profile] = positionals;
    if (!profile) fail("usage: nextdns logs <profile> [options]");
    print(
      await call("GET", `profiles/${profile}/logs`, {
        query: {
          limit: values.limit,
          cursor: values.cursor,
          from: values.from,
          to: values.to,
          search: values.search,
          status: values.status,
          device: values.device,
          sort: values.sort,
          raw: values.raw ? 1 : undefined,
        },
      }),
    );
  },

  analytics: async (rest) => {
    const { values, positionals } = parse(rest, {
      ...listOptions,
      ...timeOptions,
      device: { type: "string" },
      type: { type: "string" },
    });
    const [profile, metric] = positionals;
    if (!profile || !metric) fail("usage: nextdns analytics <profile> <metric> [options]");
    print(
      await call("GET", `profiles/${profile}/analytics/${metric}`, {
        query: {
          limit: values.limit,
          cursor: values.cursor,
          from: values.from,
          to: values.to,
          device: values.device,
          type: values.type,
        },
      }),
    );
  },

  allowlist: listEntries("allowlist"),
  denylist: listEntries("denylist"),
  allow: addEntries("allowlist", "allow"),
  deny: addEntries("denylist", "deny"),
  "allow-remove": removeEntries("allowlist", "allow-remove"),
  "deny-remove": removeEntries("denylist", "deny-remove"),

  toggle: async (rest) => {
    const { positionals } = parse(rest, {});
    const [path, state] = positionals;
    if (!path || !state) fail("usage: nextdns toggle <path> <on|off>");
    if (state !== "on" && state !== "off") fail("state must be 'on' or 'off'");
    const slash = path.lastIndexOf("/");
    if (slash <= 0) {
      fail("path must be <array-endpoint>/<id>, e.g. profiles/abc123/parentalControl/services/tiktok");
    }
    const arrayPath = path.slice(0, slash);
    const id = path.slice(slash + 1);
    const active = state === "on";

    const list = await call("GET", arrayPath);
    const entries = Array.isArray(list) ? list : (list?.data ?? []);
    const exists = entries.some((entry) => entry?.id === id);
    const result = exists
      ? await call("PATCH", path, { body: { active } })
      : await call("POST", arrayPath, { body: { id, active } });
    print(result);
  },

  patch: async (rest) => {
    const { positionals } = parse(rest, {});
    const [path, json] = positionals;
    if (!path || json === undefined) fail("usage: nextdns patch <path> <json>");
    print(await call("PATCH", path, { body: parseJson(json, "patch body") }));
  },

  post: async (rest) => {
    const { positionals } = parse(rest, {});
    const [path, json] = positionals;
    if (!path) fail("usage: nextdns post <path> [json]");
    print(
      await call("POST", path, { body: json === undefined ? {} : parseJson(json, "post body") }),
    );
  },

  delete: async (rest) => {
    const { positionals } = parse(rest, {});
    const [path] = positionals;
    if (!path) fail("usage: nextdns delete <path>");
    print(await call("DELETE", path));
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  usage();
} else {
  const handler = commands[command];
  if (!handler) {
    fail(`unknown command '${command}'. Run with --help for usage.`);
  }
  try {
    await handler(rest);
  } catch (error) {
    fail(error.message ?? String(error));
  }
}
