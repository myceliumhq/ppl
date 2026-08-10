import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJson,
  writeJsonLines,
  writeTruncationNotice,
} from "@myceliumhq/toolkit";
import { unwrapCli } from "../api.js";
import { resolveClientHandle } from "../config.js";

type Endpoint = "/api/tags/" | "/api/correspondents/" | "/api/document_types/";
type Kind = "tag" | "correspondent" | "doctype";

const KIND_CONFIG: Record<Kind, { endpoint: Endpoint; label: string }> = {
  tag: { endpoint: "/api/tags/", label: "tags" },
  correspondent: { endpoint: "/api/correspondents/", label: "correspondents" },
  doctype: { endpoint: "/api/document_types/", label: "document types" },
};

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 100;

// tags/correspondents/document_types are structurally near-identical
// (id + name) -- one shared implementation registered three times under
// different top-level command names, rather than three near-duplicate
// files, mirroring how the MCP tool (tools/taxonomy.ts) parameterizes by
// `kind` instead of splitting into three tools.
export function registerTaxonomyGroup(program: Command, cliName: string, kind: Kind): void {
  const { endpoint, label } = KIND_CONFIG[kind];
  const group = addSubcommand(program, cliName).summary(`Manage paperless-ngx ${label}.`);

  addSubcommand(group, "list")
    .summary(`List ${label}.`)
    .option("--contains <text>", "Case-insensitive name substring filter.")
    .option("--limit <n>", `Max results, capped at ${MAX_LIST_LIMIT}.`, String(DEFAULT_LIST_LIMIT))
    .action(async (options: { contains?: string; limit: string }) => {
      const limit = parseBoundedInt(options.limit, {
        min: 1,
        max: MAX_LIST_LIMIT,
        flag: "--limit",
      });
      const { client } = resolveClientHandle();
      const result = await unwrapCli(
        client.GET(endpoint, {
          params: { query: { name__icontains: options.contains, page_size: limit } },
        }),
      );
      const rows = result.results ?? [];
      writeJsonLines(rows.map((r: { id?: number; name?: string }) => ({ id: r.id, name: r.name })));
      if (result.count !== undefined && result.count > rows.length) {
        writeTruncationNotice({ shown: rows.length, total: result.count, limitFlag: "--limit" });
      }
    });

  addSubcommand(group, "create <name>")
    .summary(
      `Create a new ${kind === "tag" ? "tag" : kind === "correspondent" ? "correspondent" : "document type"}.`,
    )
    .action(async (name: string) => {
      const { client } = resolveClientHandle();
      const result = await unwrapCli(client.POST(endpoint, { body: { name } }));
      writeJson({ id: result.id, name: result.name });
    });
}
