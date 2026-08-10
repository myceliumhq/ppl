import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  parseId,
  writeJsonLines,
  writeTable,
  writeTruncationNotice,
} from "@myceliumhq/toolkit";
import { fetchNameMap } from "../../tools/relations.js";
import { unwrapCli } from "../api.js";
import { resolveClientHandle } from "../config.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

function collectIds(values: (number | null | undefined)[]): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === "number"))];
}

export function registerSearch(program: Command): void {
  addSubcommand(program, "search <query...>")
    .summary("Full-text search over documents.")
    .description(
      "Free-text search across OCR content and metadata (fuzzy, ranked). Never returns OCR " +
        "content -- use `doc content <id>` to read a specific document.",
    )
    .option("--limit <n>", `Max results, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--tag <id>", "Filter by tag id.")
    .option("--correspondent <id>", "Filter by correspondent id.")
    .option("--type <id>", "Filter by document type id.")
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

        const { client, baseUrl } = resolveClientHandle();
        const result = await unwrapCli(
          client.GET("/api/documents/", {
            params: {
              query: {
                search: query,
                tags__id: tagId,
                correspondent__id: correspondentId,
                document_type__id: typeId,
                page_size: limit,
                fields: ["id", "title", "correspondent", "document_type", "tags", "created"],
              },
            },
          }),
        );

        const docs = result.results ?? [];
        const [correspondents, documentTypes, tags] = await Promise.all([
          fetchNameMap(
            client,
            "/api/correspondents/",
            collectIds(docs.map((d) => d.correspondent)),
          ),
          fetchNameMap(
            client,
            "/api/document_types/",
            collectIds(docs.map((d) => d.document_type)),
          ),
          fetchNameMap(
            client,
            "/api/tags/",
            collectIds(docs.flatMap((d) => (Array.isArray(d.tags) ? d.tags : []))),
          ),
        ]);

        const rows = docs.map((d) => ({
          id: d.id,
          title: d.title ?? "",
          correspondent:
            typeof d.correspondent === "number" ? (correspondents.get(d.correspondent) ?? "") : "",
          type:
            typeof d.document_type === "number" ? (documentTypes.get(d.document_type) ?? "") : "",
          tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => tags.get(t) ?? t).join(","),
          url: `${baseUrl}/documents/${d.id}/details`,
        }));

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

        if (result.count !== undefined && result.count > rows.length) {
          writeTruncationNotice({ shown: rows.length, total: result.count, limitFlag: "--limit" });
        }
      },
    );
}
