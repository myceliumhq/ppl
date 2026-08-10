# Contributing

## Dev setup

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

`build`'s `tsc` excludes `*.test.ts` (test files shouldn't end up in the published `dist/`), so it
never type-checks tests. `typecheck` runs the same compiler over the whole program, tests included,
via `tsconfig.test.json` (extends the base config, `noEmit`, no exclusion). `vitest run` itself
doesn't type-check either -- it transpiles with esbuild, which strips types without checking them --
so `typecheck` is the only step that would catch a type error confined to a test file.

Node version is pinned in `.nvmrc`.

### Regenerating API types

`src/generated/paperless-schema.d.ts` is generated from your paperless-ngx instance's live OpenAPI
schema via [openapi-typescript](https://openapi-ts.dev/):

```bash
export PAPERLESS_URL=https://paperless.example.com
export PAPERLESS_TOKEN=your-api-token
pnpm run generate:types
```

Re-run this after upgrading paperless-ngx if you rely on newer filters or fields.

Note: `openapi-typescript`'s codegen currently only supports TypeScript ^5.x, while this project
builds against the latest TypeScript major. `generate:types` runs the generator through `pnpm dlx`
in an isolated resolution so it gets a compatible TypeScript without downgrading the project's own
devDependency.

## Commit messages

This repo releases via [semantic-release](https://semantic-release.gitbook.io/semantic-release/):
every commit message on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/),
because the release automation reads the commit history to decide what to publish. There is no
manual version bump anymore — don't edit `version` in `package.json`.

| Prefix | Effect |
| --- | --- |
| `fix: ...` | patch release |
| `feat: ...` | minor release |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major release |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | no release |

## Release process

Merging to `main` runs [`.github/workflows/release.yml`](./.github/workflows/release.yml), which
calls [myceliumhq/.github](https://github.com/myceliumhq/.github)'s reusable release workflow:
build, test, then `semantic-release` (config in `.releaserc.json`) computes the next version from
commits since the last release tag, publishes to npm, and creates a GitHub release with generated
notes.

Publishing uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) --
no token secret. `@myceliumhq/ppl` on npmjs.com must have a Trusted Publisher configured under
Settings → Trusted Publishing pointing at this exact repo and workflow filename
(`myceliumhq/ppl`, `.github/workflows/release.yml`) -- npm validates against *this* file, not the
shared reusable workflow it calls into, so a renamed/moved workflow file needs updating there too.
Both this file's job and the shared workflow must grant `permissions: id-token: write`, or the
OIDC token can't be minted.
