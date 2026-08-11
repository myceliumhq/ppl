---
name: "paperless"
description: "Search and read the user's paperless-ngx documents with the `ppl` CLI (search, doc, upload, tag/correspondent/doctype). On-demand: find insurance, receipts, tax docs by year, etc."
---

# Paperless (`ppl` CLI)

`ppl --help` lists every command; `ppl <command> --help` shows its flags. Config comes from
`PAPERLESS_URL`/`PAPERLESS_TOKEN` env vars -- run `ppl doctor` first if a command fails with a
config error.

Run `ppl` directly if it's on PATH (`command -v ppl`). Only if it isn't, fall back to
`npx @myceliumhq/ppl` -- substitute that prefix for `ppl` in every command below, otherwise
identical.

## Commands

| Command | Use it for |
| --- | --- |
| `ppl search <query> [--tag/--correspondent/--type id] [--from/--to YYYY-MM-DD] [--limit N]` | Full-text search across OCR content and metadata (fuzzy, ranked). Hybrid lexical+semantic automatically when PAPERLESS_SEMANTICD_URL is set -- no separate mode to pick. Never returns OCR content. |
| `ppl doc get <id>` | Metadata: title, correspondent, type, tags, dates -- names resolved alongside the ids. |
| `ppl doc content <id>` | Full OCR text to stdout, unbounded. |
| `ppl doc set <id> [--title/--correspondent/--type/--date/--tag +5,-3]` | Update metadata. `--tag` takes a comma-separated `+<id>`/`-<id>` delta to add/remove tags without disturbing the others. |
| `ppl doc download <id> --out path [--original]` | Download the original file (or the archived PDF by default). |
| `ppl upload <file> [--title/--correspondent/--type/--tags]` | Upload a document for OCR/auto-tagging. Async -- returns a task id, the document appears in `search` once processing finishes. |
| `ppl tag/correspondent/doctype list [--contains text]` | Look up an id by name before filtering or setting one -- never guess an id. |
| `ppl tag/correspondent/doctype create <name>` | Create a new one. Check `list` first to avoid a near-duplicate. |
| `ppl doctor` | Verify config and connectivity. |

## Facts

- Every list command's default output is a table or JSONL (`--json` for JSONL everywhere else).
- `search` never returns OCR content -- use `doc content <id>` to read a specific document, or
  `doc get <id>` for metadata only.
- Semantic search has no reliable "zero results" signal on its own -- it's nearest-neighbor
  cosine similarity, which always returns *something*, and a nonsense query can score within a
  few hundredths of a genuinely relevant one against the same index. Don't treat the score as a
  confidence measure. With `--json`, each row has `match_source` (`lexical`/`semantic`/`both`);
  if every result is `semantic` (no lexical hits at all), that's the real "this probably found
  nothing" signal, and `search` also prints a stderr warning in that case.
- Correspondent/tag/type ids are opaque -- always resolve a name to an id via the relevant `list`
  command before filtering or setting one, never guess.
- Exit codes are deterministic: `0` ok, `2` bad usage (fix the command), `3` not found (bad id),
  `4` config/auth (run `ppl doctor`). Branch on these instead of parsing stderr text.

## Procedure

1. `ppl search "<query>"` -- usually sufficient alone.
2. Add filters only from constraints the user actually gave:
   - correspondent name -> `ppl correspondent list --contains <name>` -> id -> `--correspondent`
   - tag -> `ppl tag list --contains <name>` -> id -> `--tag`
   - date range -> `--from`/`--to` (ISO `YYYY-MM-DD`), not the query text
3. No real hits -> broaden: synonyms, other likely languages, partial words, drop filters one at a
   time. With semantic fusion on, don't rely on an empty result list for this -- check whether
   results are all `match_source: "semantic"` (or watch for the stderr warning), since fusion
   rarely returns a truly empty list even for a query that matches nothing.
4. Present compactly: title, correspondent, date, doc id, `url` (as a link, always).
5. Know the doc id, need one specific detail (amount, policy number, clause) -> `ppl doc content
   <id> | grep -i <term>` -- always, not just for long documents. `doc content` is unbounded (full
   OCR text, no truncation), so piping straight to `grep` instead of reading it whole is the
   default move, not a fallback for when a document happens to be long.
6. Multiple plausible matches -> list for the user to pick, never guess.

## Safety rules

- Never modify anything (`doc set`, `upload`, `tag/correspondent/doctype create`) unless the user
  explicitly asked for that action -- this skill is search/retrieval-first.
- Never guess when multiple matches are plausible -- present options.
- Never fabricate or assume a document's existence or content.

## No shell available?

The same functionality is also exposed as a standalone MCP server -- see the package README for
setup and its tool list.
