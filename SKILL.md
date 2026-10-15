---
name: nextdns
description: Control and diagnose NextDNS DNS filtering through its HTTP API. List profiles, query DNS logs and analytics, manage allow and deny lists, and toggle parental-control services, categories and blocklists. Use when the user mentions NextDNS, DNS filtering or blocking, or asks why a domain is blocked or which device is querying it.
---

# NextDNS

Thin CLI over the NextDNS API (`https://api.nextdns.io`). One command, one JSON response. Read-only by default.

## Setup

- Needs Node.js 18+ and `NEXTDNS_API_KEY` in the environment.
- The key is at the bottom of the account page: https://my.nextdns.io/account
- Never print the key or write it into files. Environment only.
- `NEXTDNS_API_URL` overrides the API base URL. Rarely needed.

## Commands

Run from this skill's directory. All output is JSON.

| Command | Purpose |
| --- | --- |
| `node scripts/nextdns.mjs profiles` | List profiles (id, name) |
| `node scripts/nextdns.mjs logs <profile> [--search X] [--status blocked] [--from -24h] [--limit N] [--raw] [--cursor C]` | DNS query logs |
| `node scripts/nextdns.mjs analytics <profile> <metric> [--from -7d] [--limit 20]` | Metrics: `status`, `domains`, `reasons`, `ips`, `devices`, `protocols`, `queryTypes`, `ipVersions`, `dnssec`, `encryption`, `destinations` |
| `node scripts/nextdns.mjs allowlist <profile>` / `denylist <profile>` | List entries |
| `node scripts/nextdns.mjs allow <profile> <domain>...` / `deny <profile> <domain>...` | Add entries |
| `node scripts/nextdns.mjs allow-remove <profile> <domain>...` / `deny-remove <profile> <domain>...` | Remove entries |
| `node scripts/nextdns.mjs toggle <path> <on\|off>` | Enable or disable an array entry |
| `node scripts/nextdns.mjs get <path>` | GET any endpoint |
| `node scripts/nextdns.mjs patch <path> <json>` / `post <path> [json]` / `delete <path>` | Write any endpoint |

Append `;series` to an analytics metric for a time series (e.g. `analytics <profile> status;series --from -7d`).

## Useful paths

```
profiles
profiles/<id>                               full profile: security, privacy, parentalControl, denylist, allowlist, settings
profiles/<id>/security                      threat protection toggles, TLD blocks
profiles/<id>/privacy                       blocklists, native tracking, disguised trackers
profiles/<id>/privacy/blocklists            blocklist entries (toggle <on|off>)
profiles/<id>/parentalControl               services, categories, safeSearch, youtubeRestrictedMode, blockBypass
profiles/<id>/parentalControl/services      service entries, e.g. tiktok, fortnite
profiles/<id>/parentalControl/categories    category entries, e.g. porn, social-networks, gambling
profiles/<id>/denylist / allowlist          domain entries with an active flag
profiles/<id>/settings/performance           cnameFlattening, cacheBoost, ecs
profiles/<id>/settings/logs                 enabled, retention, location
profiles/<id>/settings/blockPage            block page toggle
profiles/<id>/settings/web3                 web3 block toggle
profiles/<id>/analytics/<metric>            see the analytics command
profiles/<id>/logs                          see the logs command
```

Object endpoints (such as `settings/performance`) accept partial JSON through `patch`. Array endpoints accept `post` for new entries; `toggle` does this automatically when the entry is missing.

## Workflows

- **Why is domain X blocked?** `logs <profile> --search X --from -24h`. Each hit carries `reasons` naming the blocklist or parental-control rule. Then `get profiles/<id>/parentalControl` (or the matching section) to inspect the rule and propose a change.
- **Top blocked apps:** `analytics <profile> reasons`, then `analytics <profile> domains --status blocked`.
- **Temporarily allow a broken site:** confirm with the user, then `allow <profile> example.com`. Remind them to revert later with `allow-remove`.
- **Parental control:** `toggle profiles/<id>/parentalControl/categories/porn on`, or `toggle profiles/<id>/parentalControl/services/tiktok on`. `toggle` deactivates entries with `off`; `*-remove` deletes them.
- **Settings change:** `patch profiles/<id>/settings/performance '{"cnameFlattening":true}'`.

## Rules

- Read-only by default. Ask the user before `allow`, `deny`, `*-remove`, `toggle`, `patch`, `post`, `delete`.
- Paginated responses carry `meta.pagination.cursor`. Continue with `--cursor`; there is no next page when it is null.
- Dates accept relative values: `-24h`, `-7d`, `-3M`, `now`.
- User errors can come back as HTTP 200 with `{ "errors": [...] }`. Always check for `errors` before treating output as success, and report `code` and `detail` as they are.
- The API is beta. When a typed command fails, fall back to `get` or `patch` on the raw path before guessing.
