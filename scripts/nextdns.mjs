#!/usr/bin/env node
// Thin CLI for the NextDNS API (docs: https://nextdns.github.io/api/).
// Auth: X-Api-Key header. The key lives at the bottom of
// https://my.nextdns.io/account and is read from the environment only.

import { createWriteStream, existsSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const DEFAULT_BASE_URL = "https://api.nextdns.io";
const ANALYTICS_METRICS = [
  "status",
  "domains",
  "reasons",
  "ips",
  "devices",
  "protocols",
  "queryTypes",
  "ipVersions",
  "dnssec",
  "encryption",
  "destinations",
];

// Arrays whose entries have no active flag: an entry is on while it exists,
// so toggling means adding or deleting it instead of patching.
const PRESENCE_ARRAYS = ["/privacy/blocklists", "/privacy/natives", "/security/tlds"];

function fail(message) {
  process.stderr.write(`nextdns: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(
    [
      "Usage: nextdns [options] <command> [args]",
      "",
      "Commands:",
      "  profiles                              List profiles (id, name)",
      "  get <path>                            GET any endpoint, e.g. profiles/abc123",
      "  logs <profile> [options]              Query DNS logs",
      "  logs-download <profile> [--out file] Get the CSV log export URL, or save it",
      "  clear-logs <profile>                 Permanently delete all logs",
      "  analytics <profile> <metric> [options]",
      "                                        Metrics: status, domains, reasons, ips,",
      "                                        devices, protocols, queryTypes, ipVersions,",
      "                                        dnssec, encryption, destinations. Append",
      "                                        ;series to a metric for a time series",
      "  allowlist <profile>                   List allowlist entries",
      "  denylist <profile>                    List denylist entries",
      "  rewrites <profile>                    List DNS rewrites (hostname overrides)",
      "  allow <profile> <domain>...           Add domain(s) to the allowlist",
      "  deny <profile> <domain>...            Add domain(s) to the denylist",
      "  allow-remove <profile> <domain>...    Remove domain(s) from the allowlist",
      "  deny-remove <profile> <domain>...     Remove domain(s) from the denylist",
      "  rewrite <profile> <name> <content>    Add a DNS rewrite (IP or CNAME target)",
      "  rewrite-remove <profile> <name|id>... Remove rewrite(s) by name or id",
      "  toggle <path> <on|off>                Enable or disable an array entry, e.g.",
      "                                        profiles/abc123/parentalControl/services/tiktok",
      "  patch <path> <json>                   PATCH any endpoint",
      "  post <path> [json]                    POST any endpoint",
      "  delete <path>                         DELETE any endpoint",
      "",
      "Options:",
      "  --profile <id>        Profile id (the first argument also works)",
      "  --limit <n>           Page size",
      "  --cursor <cursor>     Next page cursor from a previous response",
      "  --search <text>       Logs: filter by domain substring",
      "  --status <status>     Logs: default | error | blocked | allowed",
      "  --device <id>         Logs/analytics: one device id",
      "  --from <date>         Window start: -24h, -7d, 2026-01-01, ...",
      "  --to <date>           Window end",
      "  --sort <asc|desc>     Logs sort order (default desc)",
      "  --raw                 Logs: include non-navigational queries",
      "  --type <t>            Analytics: destinations type (countries | gafam)",
      "  --stream              Logs: follow the live SSE stream",
      "  --max-events <n>      Stream: stop after n events",
      "  --duration <seconds>  Stream: stop after this many seconds",
      "  --id <id>             Stream: resume from the last event id",
      "",
      "Environment:",
      "  NEXTDNS_API_KEY       Required (bottom of https://my.nextdns.io/account)",
      "  NEXTDNS_PROFILE       Default profile id when the argument is omitted",
      "  NEXTDNS_API_URL       API base URL override (default https://api.nextdns.io)",
      "",
      "All output is JSON. Errors print the API error payload to stderr and exit 1.",
      "Streaming prints one JSON object per event and a summary on stderr.",
      "",
    ].join("\n"),
  );
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

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON for ${what}: ${error.message}`);
  }
}

function requireApiKey() {
  const apiKey = process.env.NEXTDNS_API_KEY;
  if (!apiKey) {
    fail("NEXTDNS_API_KEY is not set. Find it at the bottom of https://my.nextdns.io/account");
  }
  return apiKey;
}

function buildUrl(path, query) {
  const base = process.env.NEXTDNS_API_URL || DEFAULT_BASE_URL;
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  return url;
}

async function exitWithHttpError(response, text) {
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null; // Non-JSON body; fall through to the raw text.
    }
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const wait = retryAfter ? `${retryAfter} seconds (Retry-After header)` : "a moment";
    process.stderr.write(`nextdns: rate limited (HTTP 429); wait ${wait} and retry\n`);
  }
  const detail = payload === null ? text : JSON.stringify(payload, null, 2);
  process.stderr.write(`nextdns: HTTP ${response.status}\n${detail}\n`);
  process.exit(1);
}

async function call(method, path, { query, body } = {}) {
  const url = buildUrl(path, query);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": requireApiKey(),
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
    await exitWithHttpError(response, text);
  }

  // Empty bodies, such as 204 from DELETE, come back as a minimal ack.
  return payload ?? { ok: true, status: response.status };
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// Unwrap {data: [...]} envelopes; some endpoints return bare arrays.
function entriesOf(payload) {
  return Array.isArray(payload) ? payload : (payload?.data ?? []);
}

// Profile resolution: --profile flag, first argument, then NEXTDNS_PROFILE.
// Commands with extra arguments only use the flag or the first argument, so
// an ambient NEXTDNS_PROFILE never swallows a domain or metric by mistake.
function resolveProfile(values, positional, label) {
  const profile = values?.profile ?? positional ?? process.env.NEXTDNS_PROFILE;
  if (!profile) {
    fail(`${label} needs a profile id: pass it as the first argument, --profile, or NEXTDNS_PROFILE`);
  }
  return profile;
}

// Catch the usual paste mistakes (URLs, paths, ports, spaces) before they
// reach the API as bogus list entries.
function checkDomains(domains) {
  const bad = domains.filter((domain) => !/^[^\s/:@?#]+$/.test(domain));
  if (bad.length > 0) {
    fail(`not a bare domain: ${bad.join(", ")} (use e.g. example.com, without scheme, port or path)`);
  }
}

const listOptions = {
  limit: { type: "string" },
  cursor: { type: "string" },
};

const timeOptions = {
  from: { type: "string" },
  to: { type: "string" },
};

const profileOption = {
  profile: { type: "string" },
};

const listEntries = (kind) => async (rest) => {
  const { values, positionals } = parse(rest, { ...listOptions, ...profileOption });
  const profile = resolveProfile(values, positionals[0], kind);
  print(
    await call("GET", `profiles/${profile}/${kind}`, {
      query: { limit: values.limit, cursor: values.cursor },
    }),
  );
};

const addEntries = (kind, label) => async (rest) => {
  const { values, positionals } = parse(rest, profileOption);
  const [profileArg, ...domains] = values.profile
    ? [values.profile, ...positionals]
    : positionals;
  if (domains.length === 0) {
    fail(`usage: nextdns ${label} <profile> <domain>... (or --profile <id> <domain>...)`);
  }
  checkDomains(domains);
  const profile = resolveProfile({}, profileArg, label);
  const results = [];
  for (const domain of domains) {
    results.push(await call("POST", `profiles/${profile}/${kind}`, { body: { id: domain } }));
  }
  print(results.length === 1 ? results[0] : results);
};

const removeEntries = (kind, label) => async (rest) => {
  const { values, positionals } = parse(rest, profileOption);
  const [profileArg, ...domains] = values.profile
    ? [values.profile, ...positionals]
    : positionals;
  if (domains.length === 0) {
    fail(`usage: nextdns ${label} <profile> <domain>... (or --profile <id> <domain>...)`);
  }
  checkDomains(domains);
  const profile = resolveProfile({}, profileArg, label);
  const results = [];
  for (const domain of domains) {
    results.push(
      await call("DELETE", `profiles/${profile}/${kind}/${encodeURIComponent(domain)}`),
    );
  }
  print(results.length === 1 ? results[0] : results);
};

// One Server-sent event block: "id: ..." plus one or more "data: ..." lines.
function parseSseBlock(block) {
  let id;
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment or keep-alive
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  try {
    return { id, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null; // Not JSON; ignore the event.
  }
}

// Follow /logs/stream over SSE. maxEvents and duration bound the session so
// the command always ends on its own.
async function streamLogs(profile, { search, status, device, raw, id, maxEvents, duration }) {
  const controller = new AbortController();
  const timer = duration ? setTimeout(() => controller.abort(), duration * 1000) : null;
  let events = 0;
  let lastId = null;

  let response;
  try {
    response = await fetch(buildUrl(`profiles/${profile}/logs/stream`, {
      search,
      status,
      device,
      raw,
      id,
    }), {
      headers: { "X-Api-Key": requireApiKey() },
      signal: controller.signal,
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    fail(`cannot reach the stream: ${error.cause?.message ?? error.message}`);
  }

  if (!response.ok || response.body === null) {
    if (timer) clearTimeout(timer);
    await exitWithHttpError(response, await response.text());
  }

  try {
    const decoder = new TextDecoder();
    let buffer = "";
    // eslint-disable-next-line no-labels
    outer: for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const event = parseSseBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (!event) continue;
        lastId = event.id ?? lastId;
        events += 1;
        const line = event.id === undefined ? event.data : { id: event.id, ...event.data };
        process.stdout.write(`${JSON.stringify(line)}\n`);
        if (maxEvents !== undefined && events >= maxEvents) {
          // Breaking releases the async iterator, which cancels the stream.
          break outer;
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      if (timer) clearTimeout(timer);
      fail(`stream failed: ${error.cause?.message ?? error.message}`);
    }
  }
  if (timer) clearTimeout(timer);
  const resume = lastId ? `; last id: ${lastId} (resume with --id ${lastId})` : "";
  process.stderr.write(`nextdns: stream ended after ${events} events${resume}\n`);
}

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
      ...profileOption,
      search: { type: "string" },
      status: { type: "string" },
      device: { type: "string" },
      sort: { type: "string" },
      raw: { type: "boolean" },
      stream: { type: "boolean" },
      "max-events": { type: "string" },
      duration: { type: "string" },
      id: { type: "string" },
    });
    const profile = resolveProfile(values, positionals[0], "logs");

    // Documented bounds; the API would reject them anyway, but this costs
    // no request.
    if (values.limit !== undefined) {
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 10 || limit > 1000) {
        fail("logs --limit must be an integer between 10 and 1000");
      }
    }

    if (values.stream) {
      for (const option of ["from", "to", "sort", "limit", "cursor"]) {
        if (values[option] !== undefined) {
          fail(`--${option} is not supported with --stream (use --id to resume)`);
        }
      }
      const maxEvents = values["max-events"] === undefined ? undefined : Number(values["max-events"]);
      if (maxEvents !== undefined && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
        fail("--max-events must be a positive integer");
      }
      const duration = values.duration === undefined ? undefined : Number(values.duration);
      if (duration !== undefined && (!Number.isFinite(duration) || duration < 1)) {
        fail("--duration must be a number of seconds >= 1");
      }
      // An unbounded stream never returns, which hangs an agent waiting on it.
      if (maxEvents === undefined && duration === undefined) {
        fail("--stream needs a bound: pass --max-events <n> or --duration <seconds>");
      }
      await streamLogs(profile, {
        search: values.search,
        status: values.status,
        device: values.device,
        raw: values.raw ? 1 : undefined,
        id: values.id,
        maxEvents,
        duration,
      });
      return;
    }

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

  "logs-download": async (rest) => {
    const { values, positionals } = parse(rest, { ...profileOption, out: { type: "string" } });
    const profile = resolveProfile(values, positionals[0], "logs-download");
    // Checked before the export request, which can take minutes to generate.
    if (values.out && existsSync(values.out)) {
      fail(`${values.out} already exists; pick another --out path or remove it first`);
    }
    // redirect=0 keeps the response JSON (the file URL) instead of a redirect.
    const payload = await call("GET", `profiles/${profile}/logs/download`, {
      query: { redirect: 0 },
    });
    if (!values.out) {
      print(payload);
      return;
    }
    const url = typeof payload?.data?.url === "string" ? payload.data.url : null;
    if (!url) {
      fail(`no download URL in the response: ${JSON.stringify(payload)}`);
    }
    let response;
    try {
      response = await fetch(url); // Public file URL; no API key involved.
    } catch (error) {
      fail(`cannot reach ${url}: ${error.cause?.message ?? error.message}`);
    }
    if (!response.ok) {
      process.stderr.write(`nextdns: HTTP ${response.status} fetching ${url}\n`);
      process.exit(1);
    }
    // Stream to disk: exports can weigh hundreds of MB.
    const file = createWriteStream(values.out, { flags: "wx" });
    try {
      await pipeline(Readable.fromWeb(response.body), file);
    } catch (error) {
      // EEXIST means someone else's file appeared meanwhile; leave it alone.
      if (error.code !== "EEXIST") rmSync(values.out, { force: true });
      fail(`download of ${url} failed: ${error.cause?.message ?? error.message}`);
    }
    print({ saved: values.out, bytes: file.bytesWritten, url });
  },

  "clear-logs": async (rest) => {
    const { values, positionals } = parse(rest, profileOption);
    const profile = resolveProfile(values, positionals[0], "clear-logs");
    print(await call("DELETE", `profiles/${profile}/logs`));
  },

  analytics: async (rest) => {
    const { values, positionals } = parse(rest, {
      ...listOptions,
      ...timeOptions,
      ...profileOption,
      device: { type: "string" },
      type: { type: "string" },
    });
    let profile;
    let metric;
    if (values.profile) {
      [metric] = positionals;
      profile = values.profile;
    } else if (positionals.length === 1 && process.env.NEXTDNS_PROFILE) {
      [metric] = positionals;
      profile = process.env.NEXTDNS_PROFILE;
    } else {
      [profile, metric] = positionals;
    }
    if (!metric) fail("usage: nextdns analytics <profile> <metric> [options]");
    const base = metric.split(";")[0];
    if (!ANALYTICS_METRICS.includes(base)) {
      fail(
        `unknown metric '${base}'; valid metrics: ${ANALYTICS_METRICS.join(", ")} ` +
          "(append ;series for a time series)",
      );
    }
    if (base === "destinations" && values.type !== "countries" && values.type !== "gafam") {
      fail("analytics destinations needs --type countries or --type gafam");
    }
    // Documented bounds; the API would reject them anyway, but this costs
    // no request.
    if (values.limit !== undefined) {
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        fail("analytics --limit must be an integer between 1 and 500");
      }
    }
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
  rewrites: listEntries("rewrites"),
  allow: addEntries("allowlist", "allow"),
  deny: addEntries("denylist", "deny"),
  "allow-remove": removeEntries("allowlist", "allow-remove"),
  "deny-remove": removeEntries("denylist", "deny-remove"),

  rewrite: async (rest) => {
    const { values, positionals } = parse(rest, profileOption);
    const [profileArg, name, content] = values.profile
      ? [values.profile, ...positionals]
      : positionals;
    if (name === undefined || content === undefined) {
      fail("usage: nextdns rewrite <profile> <name> <content> (or --profile <id> <name> <content>)");
    }
    const profile = resolveProfile({}, profileArg, "rewrite");
    // The API has no PATCH for rewrites; changing one means remove + re-add.
    print(await call("POST", `profiles/${profile}/rewrites`, { body: { name, content } }));
  },

  "rewrite-remove": async (rest) => {
    const { values, positionals } = parse(rest, profileOption);
    const [profileArg, ...targets] = values.profile
      ? [values.profile, ...positionals]
      : positionals;
    if (targets.length === 0) {
      fail("usage: nextdns rewrite-remove <profile> <name-or-id>... (or --profile <id> <name-or-id>...)");
    }
    const profile = resolveProfile({}, profileArg, "rewrite-remove");
    const byIdOrName = new Map();
    for (const entry of entriesOf(await call("GET", `profiles/${profile}/rewrites`))) {
      if (entry?.id) byIdOrName.set(entry.id, entry);
      if (entry?.name) byIdOrName.set(entry.name, entry);
    }
    // Resolve every target first so nothing is deleted on a partial match.
    const missing = targets.filter((target) => !byIdOrName.has(target));
    if (missing.length > 0) {
      fail(`no rewrite matching ${missing.join(", ")}; run 'rewrites ${profile}' to list them`);
    }
    const results = [];
    for (const target of targets) {
      const entry = byIdOrName.get(target);
      results.push(
        await call("DELETE", `profiles/${profile}/rewrites/${encodeURIComponent(entry.id)}`),
      );
    }
    print(results.length === 1 ? results[0] : results);
  },

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
    const entries = entriesOf(list);
    const exists = entries.some((entry) => entry?.id === id);
    // Turning off something that is not there is already done; creating an
    // inactive entry would only add clutter.
    if (!exists && !active) {
      print({ ok: true, unchanged: true, id, active });
      return;
    }
    if (PRESENCE_ARRAYS.some((suffix) => arrayPath.endsWith(suffix))) {
      if (exists === active) {
        print({ ok: true, unchanged: true, id, active });
      } else {
        print(active ? await call("POST", arrayPath, { body: { id } }) : await call("DELETE", path));
      }
      return;
    }
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
