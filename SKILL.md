---
name: nextdns
description: Control and diagnose NextDNS DNS filtering through its HTTP API. List profiles, query and stream DNS logs, pull analytics, manage allow and deny lists, DNS rewrites, and toggle parental-control services, categories and blocklists. Use when the user mentions NextDNS, DNS filtering or blocking, or asks why a domain is blocked or which device is querying it.
---

# NextDNS

Thin CLI over the NextDNS API (`https://api.nextdns.io`). One command, one JSON response. Read-only by default.

## Setup

- Needs Node.js 18.3+ (for `util.parseArgs`) and `NEXTDNS_API_KEY` in the environment.
- The key is at the bottom of the account page: https://my.nextdns.io/account
- Never print the key or write it into files. Environment only.
- `NEXTDNS_PROFILE` sets a default profile id. `NEXTDNS_API_URL` overrides the API base URL. Rarely needed.

## Commands

Run from this skill's directory. All output is JSON. The profile id comes from the first argument, `--profile <id>`, or the `NEXTDNS_PROFILE` default; with domains or metrics in the way, pass the profile explicitly (argument or flag).

| Command | Purpose |
| --- | --- |
| `node scripts/nextdns.mjs profiles` | List profiles (id, name) |
| `node scripts/nextdns.mjs logs <profile> [--search X] [--status blocked] [--from -24h] [--raw] [--fields a,b] [--cursor C]` | DNS query logs; `--fields` keeps only those entry keys (also with `--stream`) |
| `node scripts/nextdns.mjs logs <profile> --stream --status blocked --max-events 50` | Live SSE tail; `--duration <s>` bounds it too, `--id` resumes |
| `node scripts/nextdns.mjs logs-download <profile> [--out file]` | CSV log export URL, or the file itself with `--out` |
| `node scripts/nextdns.mjs clear-logs <profile>` | Permanently delete all logs (state-changing) |
| `node scripts/nextdns.mjs analytics <profile> <metric> [--from -7d] [--status blocked] [--limit 20]` | Metrics: `status`, `domains`, `reasons`, `ips`, `devices`, `protocols`, `queryTypes`, `ipVersions`, `dnssec`, `encryption`, `destinations` (needs `--type countries\|gafam`) |
| `node scripts/nextdns.mjs allowlist <profile>` / `denylist <profile>` | List entries |
| `node scripts/nextdns.mjs rewrites <profile>` | List DNS rewrites |
| `node scripts/nextdns.mjs allow <profile> <domain>...` / `deny <profile> <domain>...` | Add entries |
| `node scripts/nextdns.mjs allow-remove <profile> <domain>...` / `deny-remove <profile> <domain>...` | Remove entries |
| `node scripts/nextdns.mjs rewrite <profile> <name> <content>` | Add a DNS rewrite (hostname to IP or CNAME) |
| `node scripts/nextdns.mjs rewrite-remove <profile> <name\|id>...` | Remove rewrites by name or id |
| `node scripts/nextdns.mjs toggle <path> <on\|off>` | Enable or disable an array entry |
| `node scripts/nextdns.mjs get <path>` | GET any endpoint |
| `node scripts/nextdns.mjs patch <path> <json>` / `post <path> [json]` / `delete <path>` | Write any endpoint |

Append `;series` to an analytics metric for a time series; it needs `--from` and accepts `--interval` (`1h`, `1d` or seconds), `--alignment start|end|clock`, `--timezone <IANA>` and `--partials none|start|end|all`. Quote the metric in the shell: `analytics <profile> "status;series" --from -7d --interval 1d`.

## Useful paths

```
profiles
profiles/<id>                               full profile: security, privacy, parentalControl, denylist, allowlist, settings
profiles/<id>/security                      threat protection toggles, TLD blocks
profiles/<id>/privacy                       blocklists, native tracking, disguised trackers
profiles/<id>/privacy/blocklists            blocklist entries (toggle <on|off> adds or deletes)
profiles/<id>/privacy/natives               native tracking entries, e.g. apple, windows
profiles/<id>/parentalControl               services, categories, safeSearch, youtubeRestrictedMode, blockBypass
profiles/<id>/parentalControl/services      service entries, e.g. tiktok, fortnite
profiles/<id>/parentalControl/categories    category entries, e.g. porn, social-networks, gambling
profiles/<id>/denylist / allowlist          domain entries with an active flag
profiles/<id>/rewrites                      hostname overrides: POST {name, content}, DELETE by id, no PATCH
profiles/<id>/setup                         endpoints, DoH/DoT ids, linkedIp (updateToken is a secret)
profiles/<id>/settings/performance          cnameFlattening, cacheBoost, ecs
profiles/<id>/settings/logs                 enabled, retention, location
profiles/<id>/settings/blockPage            block page toggle
profiles/<id>/settings/web3                 web3 block toggle
profiles/<id>/analytics/<metric>            see the analytics command
profiles/<id>/logs                          see the logs command
```

Rewrites are not in the official API docs yet; the shape above matches what the web app itself uses.

## Workflows

- **Why is domain X blocked?** `logs <profile> --search X --from -24h --fields timestamp,domain,device,status,reasons`. `--fields` drops transport details that waste context. Each hit carries `reasons` naming the blocklist or parental-control rule. Then `get profiles/<id>/parentalControl` (or the matching section) to inspect the rule and propose a change.
- **What is being queried right now?** `logs <profile> --stream --max-events 50`. Each stdout line is one log event; the stderr summary carries the last event id for `--id` resume. Filter with `--status blocked`, `--search X` or `--device <id>`. To stitch a page of recent logs with the live stream, pass the `meta.stream.id` from a `logs` response as `--id`.
- **Top blocked apps:** `analytics <profile> reasons`, then `analytics <profile> domains --status blocked`.
- **Temporarily allow a broken site:** confirm with the user, then `allow <profile> example.com`. Note every domain you added; before ending the task, list them and offer `allow-remove` with the exact names. If an entry was already there, it is not yours to remove.
- **Parental control:** `toggle profiles/<id>/parentalControl/categories/porn on`, or `toggle profiles/<id>/parentalControl/services/tiktok on`. `toggle` deactivates entries with `off`; `*-remove` deletes them. Blocklists, natives and TLDs have no active flag: there `toggle on` adds the entry and `off` deletes it. `off` on a missing entry changes nothing.
- **Point a hostname at a local box:** `rewrite <profile> nas.home 192.168.1.100` (or a CNAME target). To change one, remove and re-add: the API has no PATCH for rewrites.
- **Export logs for analysis:** `logs-download <profile> --out logs.csv`. The export is generated server-side; with millions of queries it can take minutes and weigh hundreds of MB. The CLI streams it to disk and refuses to overwrite an existing file.
- **Settings change:** `patch profiles/<id>/settings/performance '{"cnameFlattening":true}'`.
- **Linked IP (non-encrypted DNS from a dynamic IP):** `get profiles/<id>/setup`; `data.linkedIp.ip` is the IP NextDNS currently trusts. If it differs from the user's public IP, plain DNS from that network falls back to defaults. The response also carries `linkedIp.updateToken`, a credential: never repeat it, and let the user update the IP from their router or the NextDNS setup page.
- **Compare two profiles:** `get profiles/<a>` and `get profiles/<b>`, then report differences per section (`security`, `privacy`, `parentalControl`, `denylist`, `allowlist`, `settings`) instead of dumping both.

## Rules

- Read-only by default. Ask the user before `allow`, `deny`, `*-remove`, `toggle`, `patch`, `post`, `delete`, `rewrite`, `rewrite-remove`, `clear-logs`.
- `clear-logs` permanently deletes every log of the profile.
- `logs --stream` needs `--max-events` or `--duration`; the CLI refuses an unbounded stream.
- Paginated responses carry `meta.pagination.cursor`. Continue with `--cursor`; there is no next page when it is null.
- Dates accept relative values: `-24h`, `-7d`, `-3M`, `now`.
- `logs --limit` runs from 10 to 1000 and `analytics --limit` from 1 to 500; the CLI enforces both before spending a request.
- User errors can come back as HTTP 200 with `{ "errors": [...] }`. Always check for `errors` before treating output as success, and report `code` and `detail` as they are.
- On HTTP 429 the CLI prints the wait (Retry-After). Wait it out; do not retry in a tight loop.
- The API is beta. When a typed command fails, fall back to `get` or `patch` on the raw path before guessing.
