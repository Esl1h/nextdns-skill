# nextdns

Agent skill that controls and diagnoses NextDNS, the cloud DNS filtering service, through its HTTP API.

A thin CLI wraps the whole API surface: one command, one JSON response. Node.js 18.3+, no dependencies. The skill is read-only by default: the agent asks the user before any state-changing command, and credentials come from the environment only.

## What the skill can do

**Diagnose filtering.** Find why a domain is blocked: `logs <profile> --search netflix.com --from -24h` returns each query with the exact rule that blocked it (blocklist, parental-control category or denylist entry). Rank what gets blocked: `analytics <profile> reasons`, `analytics <profile> domains --status blocked`. Break traffic down per device, protocol, query type, DNSSEC validation or destination, with time series such as `analytics <profile> "status;series" --from -7d --interval 1d`.

**Watch DNS in real time.** `logs <profile> --stream --status blocked --max-events 50` follows the live SSE stream: one JSON object per event, bounded by `--max-events` or `--duration`, resumable with `--id` (the closing summary prints the resume id). To continue a page of recent logs without gaps, pass the `meta.stream.id` from a `logs` response as `--id`.

**Manage allow and deny lists.** `allow` and `deny <profile> <domain>...` add entries; `allow-remove` and `deny-remove` remove them. Useful for temporarily allowing a site that a blocklist breaks, then reverting.

**Toggle parental control and blocklists.** `toggle profiles/<id>/parentalControl/services/tiktok on` blocks an app, `.../categories/porn on` blocks a category, `.../privacy/blocklists/oisd off` switches a blocklist off. `toggle` creates missing entries, so enabling something new is one command. Blocklists, native trackers and TLDs have no active flag, so for them `off` deletes the entry.

**Rewrite DNS for local hostnames.** `rewrite <profile> nas.home 192.168.1.100` points a hostname at an IP or CNAME target, `rewrites` lists them, `rewrite-remove` deletes by name or id. The API has no update for rewrites: changing one means remove and re-add.

**Export and clean data.** `logs-download <profile> --out logs.csv` fetches the full CSV export, generated server-side: with millions of queries it can take minutes and weigh hundreds of MB. `clear-logs <profile>` permanently deletes the profile logs.

**Reach the rest of the API.** `get`, `patch`, `post` and `delete <path>` hit any endpoint the typed commands do not cover yet, with pagination (`--cursor`) and relative dates (`-24h`, `-7d`, `-3M`).

Every command prints JSON. The profile id comes from the first argument, `--profile <id>`, or the `NEXTDNS_PROFILE` default.

## Safety model

- Read-only by default; the skill's rules require user confirmation for `allow`, `deny`, `*-remove`, `toggle`, `rewrite`, `rewrite-remove`, `clear-logs`, `patch`, `post`, `delete`.
- The API key is read from the environment only, never printed or written to files.
- Log streams always carry a bound (`--max-events` or `--duration`) so sessions end on their own.
- Invalid input fails locally before spending a request: unknown metrics, out-of-range limits, malformed domains.

## Install

With the skills CLI (https://skills.sh), which supports OpenCode, Claude Code and other agents:

```sh
npx skills add Esl1h/nextdns-skill
```

As a Claude Code plugin:

```text
/plugin marketplace add Esl1h/nextdns-skill
/plugin install nextdns@nextdns
```

For OpenCode, link this repository inside a skills directory (`~/.config/opencode/skills`, `~/.claude/skills`, `.agents/skills`); OpenCode loads skills from those directories and needs no plugin manifest. Do not point OpenCode's `skills` config directly at this repository root: a root-level `SKILL.md` gets the literal ID `SKILL` in OpenCode V2.

```sh
ln -s /path/to/this-repo ~/.config/opencode/skills/nextdns
```

## Configuration

| Variable | Required | Where to get it |
| --- | --- | --- |
| `NEXTDNS_API_KEY` | yes | Bottom of https://my.nextdns.io/account |
| `NEXTDNS_PROFILE` | no | Default profile id for commands that take none other |
| `NEXTDNS_API_URL` | no | API base URL override (default `https://api.nextdns.io`) |

The skill needs Node.js 18.3+. See [SKILL.md](SKILL.md) for the full command reference, useful API paths and agent workflows.

## Development

No build step. Tests run the CLI against a mock API server, including SSE streaming and every error path; no NextDNS account is needed. CI runs them on Node 18, 20 and 22.

```sh
node --test tests/*.test.mjs
```

## License

MIT
