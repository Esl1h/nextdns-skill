# Agent guide

This file explains how to change this skill without breaking it.

## What this repository contains

An agent skill that controls NextDNS through its documented HTTP API (`https://api.nextdns.io`), with a thin Node CLI that prints JSON.

- `SKILL.md` is the source of truth for the skill.
- `scripts/nextdns.mjs` is the CLI (Node 18.3+, no dependencies).
- `tests/nextdns.test.mjs` runs the CLI against a mock API.
- `evals/triggers.json` holds prompts that should and should not load the skill; rerun it after changing the `description`.
- `.github/workflows/test.yml` runs the tests on Node 18, 20 and 22.
- `README.md` documents installation, configuration and development.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` describe the Claude Code plugin and point the skill loader at the root `SKILL.md`.

There is no build step.

## Rules for changes

- Keep the skill in English and portable across agents. Do not write instructions that tie it to one or two specific agent tools.
- Credentials come from environment variables only (`NEXTDNS_API_KEY`). Never put keys in code, examples or logs.
- The skill reads by default. State-changing actions require user confirmation; keep that rule in `SKILL.md`.
- The CLI uses only the Node standard library. Do not add dependencies.
- Node's `parseArgs` rejects values that start with a dash; the CLI normalizes `--from -24h` into `--from=-24h` before parsing. Do not remove that normalization: NextDNS relative dates depend on it.
- Log streaming (`logs --stream`) always requires a bound (`--max-events` or `--duration`); an unbounded session hangs the agent. To stop the stream mid-`for await`, use `break`: the async iterator cancels the stream. Calling `response.body.cancel()` while the iterator is active throws `ReadableStream is locked`.
- The rewrites endpoint has no PATCH in the API: changing a rewrite means removing and re-creating it. The CLI resolves names to ids before deleting and aborts when any target does not match; keep both guarantees.
- Keep the two `.claude-plugin/` files in sync with `SKILL.md` (name, description, keywords). Bump the version in `plugin.json` whenever the skill's behavior changes.
- OpenCode has no plugin manifest for skills: they are discovered from the skills directories (`~/.config/opencode/skills`, `~/.claude/skills`, `.agents/skills`) or installed by the skills.sh CLI. Do not create a manifest for OpenCode.

## Checks

Before publishing, run the tests:

```sh
node --test tests/*.test.mjs
```

No NextDNS account is needed; the tests run against a mock API.

## Writing style

Plain, direct language: active voice, short sentences, one term per thing. Identifiers, commands, API output and error messages stay exactly as they are. Keep diacritics correct whenever Portuguese appears.
