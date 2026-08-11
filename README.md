# ppl

[![CI](https://github.com/myceliumhq/ppl/actions/workflows/ci.yml/badge.svg)](https://github.com/myceliumhq/ppl/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An agent-facing CLI for [paperless-ngx](https://docs.paperless-ngx.com/). Search, read, and
manage documents -- covering the same workflows you'd otherwise do by hand in paperless-ngx's own
UI.

Built for coding agents: token-cheap `--help`, deterministic exit codes, file-path-based
upload/download I/O, no interactive prompts.

A standalone [MCP](https://modelcontextprotocol.io) server is also included, for hosts without a
shell.

## Use

No install step needed -- `npx` fetches and caches it on first run:

```bash
export PAPERLESS_URL=https://paperless.example.com
export PAPERLESS_TOKEN=your-api-token  # Settings -> My Profile -> API Token

npx @myceliumhq/ppl doctor
npx @myceliumhq/ppl search "invoice 2026"
npx @myceliumhq/ppl doc get 42
npx @myceliumhq/ppl doc content 42
npx @myceliumhq/ppl doc set 42 --correspondent 7 --tag +5,-3
npx @myceliumhq/ppl doc download 42 --out invoice.pdf
npx @myceliumhq/ppl upload ./invoice.pdf --correspondent 7
npx @myceliumhq/ppl tag list --contains insurance
```

Prefer a global install to skip `npx`'s resolve step on every call (or if you're scripting many
invocations in a loop):

```bash
npm install --global @myceliumhq/ppl
ppl doctor
```

See `ppl <command> --help` for flags on any command, or the bundled skill
(`skills/paperless/SKILL.md`) for the full command reference and decision guidance.

## Semantic search

`ppl search` is full-text/lexical by default. Optional semantic search is available as a separate
sidecar, `ppl-semanticd` -- this package's own binary, built on
[`@myceliumhq/semanticd`](https://github.com/myceliumhq/semanticd) with this repo's paperless-ngx
adapter wired in directly. Run it alongside your paperless-ngx instance and it syncs a local
vector index:

```bash
export PAPERLESS_URL=https://paperless.example.com
export PAPERLESS_TOKEN=your-api-token
export EMBEDDING_PROVIDER=local   # zero-API-key CPU model; or openai-compatible, see semanticd's README

npx -p @myceliumhq/ppl ppl-semanticd
```

Or as a container: `ghcr.io/myceliumhq/ppl-semanticd:<version>` (built from `Dockerfile.semanticd`,
published on every tagged release). Once it's running, point both the CLI and the standalone MCP
server below at it with `PAPERLESS_SEMANTICD_URL` -- `ppl search` fuses its own lexical results
with the sidecar's over HTTP (`GET /query?q=...`) automatically, no separate mode to pick:

```bash
export PAPERLESS_SEMANTICD_URL=http://localhost:4499
npx @myceliumhq/ppl search "insurance documents from a trip"
```

Unset (or the sidecar unreachable), `ppl search` transparently falls back to lexical-only --
nothing to configure to keep using it without a sidecar.

## Standalone MCP server

The same functionality also runs outside a shell entirely, as an ordinary MCP server (stdio or
Streamable HTTP), via [`@myceliumhq/mcp`](https://github.com/myceliumhq/toolkit/tree/main/packages/mcp).
Useful for any MCP client -- Claude Desktop, Claude Code, etc.

Configuration is env vars instead of a config file:

| Env var | Required | Notes |
| --- | --- | --- |
| `PAPERLESS_URL` | yes | Base URL of the paperless-ngx instance |
| `PAPERLESS_TOKEN` | yes | API token |
| `PAPERLESS_URL_FILE` / `PAPERLESS_TOKEN_FILE` | no | Docker-secret variants: path to a file whose trimmed contents are used instead |
| `PAPERLESS_READ_ONLY` | no | Set to exactly `true` to register only read tools -- write tools aren't registered at all, so they can't be listed or called. Not a substitute for authenticating the HTTP transport |
| `PAPERLESS_SEMANTICD_URL` | no | Base URL of a deployed `ppl-semanticd` sidecar (see "Semantic search" above). Unset falls back to lexical-only search |
| `PAPERLESS_SEMANTIC_SEARCH_ENABLED` | no | Set to exactly `false` to skip semantic search even if `PAPERLESS_SEMANTICD_URL` is set |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` |
| `MCP_PORT` | no | Only used with `MCP_TRANSPORT=http`; default `3000` |
| `MCP_HOST` | no | Only used with `MCP_TRANSPORT=http`; default `127.0.0.1` (loopback-only). Set to `0.0.0.0` only behind an authenticated reverse proxy, and only with `MCP_ALLOWED_HOSTS` set (or startup fails) |
| `MCP_ALLOWED_HOSTS` | no | Comma-separated hostnames the server accepts in `Host` (DNS-rebinding protection). Required when `MCP_HOST=0.0.0.0` |

```bash
pnpm run build
PAPERLESS_URL=https://paperless.example.com PAPERLESS_TOKEN=your-api-token pnpm run start:mcp
```

A `Dockerfile` is included for building a container image locally (`Dockerfile.semanticd` for the
semantic search sidecar above).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, regenerating API types, and commit
conventions.
