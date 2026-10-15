# nextdns

Agent skill that controls NextDNS through its HTTP API: profiles, DNS logs (including a live SSE stream), analytics, allow and deny lists, DNS rewrites, parental-control toggles, and raw endpoint access.

Thin CLI, one command, one JSON response. Node.js 18+, no dependencies. Read-only by default: the agent asks the user before any state-changing command. Credentials come from the environment only.

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

## Usage

See [SKILL.md](SKILL.md) for the full command reference, useful API paths and workflows. The short version:

```sh
node scripts/nextdns.mjs profiles
node scripts/nextdns.mjs logs <profile> --search facebook.com --from -24h
node scripts/nextdns.mjs logs <profile> --stream --status blocked --max-events 50
node scripts/nextdns.mjs analytics <profile> reasons
node scripts/nextdns.mjs deny <profile> badsite.com
node scripts/nextdns.mjs rewrite <profile> nas.home 192.168.1.100
node scripts/nextdns.mjs toggle profiles/<profile>/parentalControl/services/tiktok on
```

## Development

No build step. Tests run the CLI against a mock API server; no NextDNS account is needed.

```sh
node --test tests/*.test.mjs
```

## License

MIT
