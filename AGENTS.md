# AGENTS.md

## Using this CLI

No install needed for one-off use: `npx @myceliumhq/ppl <command>`. Needs `PAPERLESS_URL` and
`PAPERLESS_TOKEN` set (an API token from paperless-ngx's Settings -> My Profile -> API Token).
Read `skills/paperless/SKILL.md` first for the command reference and decision guidance instead of
discovering it via `--help` alone -- it also covers safety rules (never write without being
asked, never guess between multiple matches).

@README.md has what this package does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## Layout

- `src/cli/` — the `ppl` CLI (primary interface): `index.ts` wires Commander subcommands from
  `commands/*.ts` onto `@myceliumhq/toolkit`'s `createProgram`/`runProgram`; `api.ts` maps API
  errors to this toolkit's exit-code contract (404→3, 401/403→4); `config.ts` resolves
  `PAPERLESS_URL`/`PAPERLESS_TOKEN` lazily so `--help` never requires them set.
- `src/agent-tool.ts` — the `AnyAgentTool` shape tool factories type their return value against
- `src/tools/` — one file per tool group (documents, taxonomy, relations, pagination)
- `src/client.ts` — typed paperless-ngx API client
- `src/generated/paperless-schema.d.ts` — generated, do not hand-edit (see CONTRIBUTING.md)
- `src/semantic/` — wires `@myceliumhq/embed` (pluggable embedding provider) and `@myceliumhq/index`
  (the actual store/sync/search engine) together; `source-adapter.ts` is the only paperless-specific
  piece (implements `@myceliumhq/index`'s `SourceAdapter`). Don't reintroduce a local
  sqlite-vec/embedding-provider implementation here — that duplication is exactly what got extracted
  into the [toolkit](https://github.com/myceliumhq/toolkit) packages (`@myceliumhq/embed`,
  `@myceliumhq/index`).
- `src/mcp-server.ts` — standalone MCP server entrypoint on `@myceliumhq/mcp` (stdio/HTTP), configured
  via env vars (see README's "Standalone MCP server" section); `createAllTools` there is the app's
  complete tool list, importable by tests without booting a server. `src/mcp-server-config.ts` holds
  the (tested) env-var parsing.
- `skills/` — agent skills bundled with the package
- `*.test.ts` — colocated with the source they test

## Working in this repo

- Run `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` before committing.
  `build`'s `tsc` excludes test files from the compile; `typecheck` is the one that type-checks them.
- Commit messages **must** follow Conventional Commits — semantic-release derives the npm version
  and GitHub release from them on every push to `main`. A non-conventional message just won't ship.
- Never hand-edit `version` in `package.json` — semantic-release owns it.
- A brand-new package's first npm publish is a manual, one-time bootstrap step (see
  CONTRIBUTING.md) — don't try to "fix" a failing first release by adding more workflow logic.
