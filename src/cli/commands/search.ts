import { createSemanticdClient } from "@myceliumhq/semanticd";
import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  parseBoundedInt,
  parseId,
  writeJsonLines,
  writeStderr,
  writeTable,
  writeTruncationNotice,
} from "@myceliumhq/toolkit";
import { unwrap } from "../../client.js";
import { fetchNameMap } from "../../tools/relations.js";
import { unwrapCli } from "../api.js";
import { resolveClientHandle } from "../config.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
const RRF_K = 60;
const FIELDS = ["id", "title", "correspondent", "document_type", "tags", "created"];

type Doc = {
  id?: number;
  title?: string | null;
  correspondent?: number | null;
  document_type?: number | null;
  tags?: unknown;
};

type Row = {
  id: number;
  title: string;
  correspondent: string;
  type: string;
  tags: string;
  url: string;
  content_snippet?: string;
  content_snippet_start_line?: number;
  content_snippet_end_line?: number;
  // Only set when semantic fusion actually ran. "semantic" (no lexical hit
  // at all) is the real no-match proxy an agent should key on -- semantic
  // similarity scores are NOT a calibrated confidence measure (live-tested:
  // a nonsense query and a genuinely relevant one can score within ~0.05 of
  // each other against the same index), so don't threshold on the score
  // itself, only on whether a lexical hit backs it up.
  match_source?: "lexical" | "semantic" | "both";
  semantic_score?: number;
};

function collectIds(values: (number | null | undefined)[]): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === "number"))];
}

// paperless-ngx's created__date__gte/lte take a bare ISO date, not a
// datetime -- validate the shape here instead of letting a typo'd flag
// silently become a no-op filter on the wire.
function parseIsoDate(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new CliError(`${flag} must be an ISO date (YYYY-MM-DD)`, {
      exitCode: EXIT_CODES.usage,
    });
  }
  return raw;
}

// Fuses lexical rank order with semantic rank order via Reciprocal Rank
// Fusion -- same RRF_K and approach as the MCP server's
// paperless_search_documents (src/tools/documents.ts's mergeSemanticMatches),
// just working over plain document ids here instead of full shaped
// objects. Returns the final ordered id list, capped at `limit`; resolving
// an id (lexical or semantic-only) to a displayable row is the caller's job.
function fuseRankedIds(
  lexicalIds: number[],
  semanticIds: number[],
  limit: number,
): { ids: number[]; truncated: boolean } {
  const lexicalRank = new Map(lexicalIds.map((id, i) => [id, i + 1]));
  const semanticRank = new Map(semanticIds.map((id, i) => [id, i + 1]));
  const semanticOnly = semanticIds.filter((id) => !lexicalRank.has(id));
  const pool = [...lexicalIds, ...semanticOnly];

  const score = (id: number): number => {
    let s = 0;
    const lr = lexicalRank.get(id);
    const sr = semanticRank.get(id);
    if (lr !== undefined) s += 1 / (RRF_K + lr);
    if (sr !== undefined) s += 1 / (RRF_K + sr);
    return s;
  };

  const ids = pool
    .map((id, index) => ({ id, index, score: score(id) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.id);

  return { ids, truncated: pool.length > limit };
}

export function registerSearch(program: Command): void {
  addSubcommand(program, "search <query...>")
    .summary("Full-text search over documents, hybridized with semantic search when configured.")
    .description(
      "Free-text search across OCR content and metadata (fuzzy, ranked). Never returns OCR " +
        "content -- use `doc content <id>` to read a specific document. When " +
        "PAPERLESS_SEMANTICD_URL is set (a deployed ppl-semanticd sidecar), results are fused with " +
        "a semantic search pass automatically -- no separate mode to pick, same as the MCP server's " +
        "paperless_search_documents. --json rows then include match_source (lexical/semantic/both); " +
        "semantic-only results with no lexical backing print a stderr warning (semantic similarity " +
        "scores are not a calibrated relevance measure).",
    )
    .option("--limit <n>", `Max results, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--tag <id>", "Filter by tag id.")
    .option("--correspondent <id>", "Filter by correspondent id.")
    .option("--type <id>", "Filter by document type id.")
    .option("--from <date>", "Only documents with created date >= this ISO date (YYYY-MM-DD).")
    .option("--to <date>", "Only documents with created date <= this ISO date (YYYY-MM-DD).")
    .option("--json", "Emit JSONL (one result per line) instead of a table.")
    .addHelpText("after", '\nExample: ppl search "invoice 2026"')
    .action(
      async (
        queryParts: string[],
        options: {
          limit: string;
          tag?: string;
          correspondent?: string;
          type?: string;
          from?: string;
          to?: string;
          json?: boolean;
        },
      ) => {
        const query = queryParts.join(" ");
        const limit = parseBoundedInt(options.limit, { min: 1, max: MAX_LIMIT, flag: "--limit" });

        const tagId = options.tag === undefined ? undefined : parseId(options.tag, "--tag");
        const correspondentId =
          options.correspondent === undefined
            ? undefined
            : parseId(options.correspondent, "--correspondent");
        const typeId = options.type === undefined ? undefined : parseId(options.type, "--type");
        const createdFrom =
          options.from === undefined ? undefined : parseIsoDate(options.from, "--from");
        const createdTo = options.to === undefined ? undefined : parseIsoDate(options.to, "--to");

        const semanticdUrl = process.env.PAPERLESS_SEMANTICD_URL;
        const useSemantic = semanticdUrl !== undefined && query.length > 0;

        const { client, baseUrl } = resolveClientHandle();
        // Unlike Trilium's ETAPI, paperless-ngx's list endpoint returns an
        // accurate total `count` regardless of page_size -- no need for
        // tri's "+1 trick" here in the non-semantic path.
        const result = await unwrapCli(
          client.GET("/api/documents/", {
            params: {
              query: {
                search: query,
                tags__id: tagId,
                correspondent__id: correspondentId,
                document_type__id: typeId,
                created__date__gte: createdFrom,
                created__date__lte: createdTo,
                page_size: limit,
                fields: FIELDS,
              },
            },
          }),
        );

        const docs = (result.results ?? []) as Doc[];
        const docById = new Map<number, Doc>();
        const lexicalIds: number[] = [];
        for (const doc of docs) {
          if (typeof doc.id !== "number") continue;
          lexicalIds.push(doc.id);
          docById.set(doc.id, doc);
        }

        const snippetById = new Map<
          number,
          { snippet: string; startLine: number; endLine: number }
        >();
        let finalIds: number[];
        let truncated: boolean;
        // Populated only on a successful semantic pass -- used below to tag
        // each row's match_source/semantic_score, and to warn when every
        // result is semantic-only (see the no-lexical-hits check after rows
        // are built).
        let semanticIds: number[] = [];
        const semanticScoreById = new Map<number, number>();

        if (useSemantic) {
          try {
            const semanticClient = createSemanticdClient(semanticdUrl as string);
            const semanticMatches = await semanticClient.query(query, limit);
            semanticIds = semanticMatches
              .map((match) => Number(match.sourceId))
              .filter((id) => Number.isFinite(id));
            for (const match of semanticMatches) {
              const id = Number(match.sourceId);
              if (Number.isFinite(id)) {
                snippetById.set(id, {
                  snippet: match.snippet,
                  startLine: match.startLine,
                  endLine: match.endLine,
                });
                semanticScoreById.set(id, match.score);
              }
            }

            // Resolve any semantic-only id (found by meaning, absent from
            // the lexical batch) in one batch call -- paperless-ngx's
            // id__in supports this directly, unlike Trilium's ETAPI.
            const missingIds = semanticIds.filter((id) => !docById.has(id));
            if (missingIds.length > 0) {
              const missing = unwrap(
                await client.GET("/api/documents/", {
                  params: {
                    query: { id__in: missingIds, page_size: missingIds.length, fields: FIELDS },
                  },
                }),
              );
              for (const doc of (missing.results ?? []) as Doc[]) {
                if (typeof doc.id === "number") docById.set(doc.id, doc);
              }
            }

            const fused = fuseRankedIds(lexicalIds, semanticIds, limit);
            finalIds = fused.ids;
            truncated = fused.truncated;
          } catch {
            // Sidecar unreachable/erroring -- fail open to lexical-only,
            // same as the MCP server's own handle.search() contract.
            finalIds = lexicalIds.slice(0, limit);
            truncated = typeof result.count === "number" && result.count > finalIds.length;
          }
        } else {
          finalIds = lexicalIds.slice(0, limit);
          truncated = typeof result.count === "number" && result.count > finalIds.length;
        }

        const finalDocs = finalIds
          .map((id) => docById.get(id))
          .filter((d): d is Doc => d !== undefined);
        const [correspondents, documentTypes, tags] = await Promise.all([
          fetchNameMap(
            client,
            "/api/correspondents/",
            collectIds(finalDocs.map((d) => d.correspondent)),
          ),
          fetchNameMap(
            client,
            "/api/document_types/",
            collectIds(finalDocs.map((d) => d.document_type)),
          ),
          fetchNameMap(
            client,
            "/api/tags/",
            collectIds(finalDocs.flatMap((d) => (Array.isArray(d.tags) ? d.tags : []))),
          ),
        ]);

        const lexicalIdSet = new Set(lexicalIds);
        const semanticIdSet = new Set(semanticIds);
        const rows: Row[] = finalDocs.map((d) => {
          const id = d.id as number;
          const snippet = snippetById.get(id);
          const inLexical = lexicalIdSet.has(id);
          const inSemantic = semanticIdSet.has(id);
          return {
            id,
            title: d.title ?? "",
            correspondent:
              typeof d.correspondent === "number"
                ? (correspondents.get(d.correspondent) ?? "")
                : "",
            type:
              typeof d.document_type === "number" ? (documentTypes.get(d.document_type) ?? "") : "",
            tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => tags.get(t) ?? t).join(","),
            url: `${baseUrl}/documents/${id}/details`,
            ...(snippet
              ? {
                  content_snippet: snippet.snippet,
                  content_snippet_start_line: snippet.startLine,
                  content_snippet_end_line: snippet.endLine,
                }
              : {}),
            ...(useSemantic
              ? {
                  match_source: (inLexical && inSemantic
                    ? "both"
                    : inLexical
                      ? "lexical"
                      : "semantic") as Row["match_source"],
                  ...(semanticScoreById.has(id)
                    ? { semantic_score: semanticScoreById.get(id) }
                    : {}),
                }
              : {}),
          };
        });

        // The real no-match signal: fusion still returns nearest-neighbor
        // semantic hits for nonsense queries (cosine similarity has no
        // reliable "nothing matches" floor -- verified against the live
        // index), so zero lexical hits is what actually means "this query
        // found nothing," not an empty result list.
        if (useSemantic && lexicalIds.length === 0 && rows.length > 0) {
          const bestScore = Math.max(...rows.map((r) => r.semantic_score ?? 0));
          writeStderr(
            `# no lexical matches for this query -- ${rows.length} semantic-only result(s) shown ` +
              `(best score ${bestScore.toFixed(3)}). Semantic similarity is not a calibrated ` +
              "relevance score; verify these are actually relevant before relying on them.",
          );
        }

        if (options.json) {
          writeJsonLines(rows);
        } else {
          writeTable(rows, [
            { header: "ID", value: (r) => String(r.id), maxWidth: 8 },
            { header: "CORRESPONDENT", value: (r) => r.correspondent, maxWidth: 20 },
            { header: "TYPE", value: (r) => r.type, maxWidth: 14 },
            { header: "TITLE", value: (r) => r.title, maxWidth: 50 },
          ]);
        }

        if (truncated) {
          writeTruncationNotice({
            shown: rows.length,
            total: typeof result.count === "number" ? result.count : undefined,
            limitFlag: "--limit",
          });
        }
      },
    );
}
