import { writeFileSync } from "node:fs";
import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  parseId,
  writeJson,
  writeStdout,
} from "@myceliumhq/toolkit";
import { fetchNameMap } from "../../tools/relations.js";
import { unwrapCli } from "../api.js";
import { resolveClientHandle } from "../config.js";

function collectIds(values: (number | null | undefined)[]): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === "number"))];
}

// `+5,-3` -> add tag id 5, remove tag id 3 -- paperless-ngx's bulk_edit
// modify_tags method applies both atomically server-side (no read-modify-
// write race against the document's current tags), matching how the
// existing MCP tool (paperless_update_document's add_tag_ids/
// remove_tag_ids) already does this.
function parseTagDelta(raw: string): { add: number[]; remove: number[] } {
  const add: number[] = [];
  const remove: number[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed === "") continue;
    const sign = trimmed[0];
    const idPart = sign === "+" || sign === "-" ? trimmed.slice(1) : trimmed;
    const id = parseId(idPart, "--tag entry");
    (sign === "-" ? remove : add).push(id);
  }
  return { add, remove };
}

export function registerDoc(program: Command): void {
  const doc = addSubcommand(program, "doc")
    .summary("Documents -- get, content, set, download.")
    .description("Manage individual documents by id.");

  addSubcommand(doc, "get <id>")
    .summary("Document metadata, with names resolved.")
    .action(async (idArg: string) => {
      const id = parseId(idArg);
      const { client, baseUrl } = resolveClientHandle();
      const document = await unwrapCli(
        client.GET("/api/documents/{id}/", {
          params: {
            path: { id },
            query: { fields: ["id", "title", "correspondent", "document_type", "tags", "created"] },
          },
        }),
      );

      const [correspondents, documentTypes, tags] = await Promise.all([
        fetchNameMap(client, "/api/correspondents/", collectIds([document.correspondent])),
        fetchNameMap(client, "/api/document_types/", collectIds([document.document_type])),
        fetchNameMap(
          client,
          "/api/tags/",
          collectIds(Array.isArray(document.tags) ? document.tags : []),
        ),
      ]);

      writeJson({
        id: document.id,
        title: document.title,
        correspondent: document.correspondent,
        correspondent_name:
          typeof document.correspondent === "number"
            ? correspondents.get(document.correspondent)
            : undefined,
        document_type: document.document_type,
        document_type_name:
          typeof document.document_type === "number"
            ? documentTypes.get(document.document_type)
            : undefined,
        tags: document.tags,
        tag_names: (Array.isArray(document.tags) ? document.tags : []).map((t) => tags.get(t) ?? t),
        created: document.created,
        url: `${baseUrl}/documents/${document.id}/details`,
      });
    });

  addSubcommand(doc, "content <id>")
    .summary("Document's OCR text to stdout.")
    .description("Full OCR content to stdout, unbounded. Pipe-clean: only content on stdout.")
    .addHelpText("after", "\nExample: ppl doc content 42 > invoice.txt")
    .action(async (idArg: string) => {
      const id = parseId(idArg);
      const { client } = resolveClientHandle();
      const document = await unwrapCli(
        client.GET("/api/documents/{id}/", {
          params: { path: { id }, query: { fields: ["id", "content"] } },
        }),
      );
      writeStdout(typeof document.content === "string" ? document.content : "");
    });

  addSubcommand(doc, "set <id>")
    .summary("Update title, correspondent, type, date, or tags.")
    .description(
      "Patch a document's metadata. Only provided fields change. --tag takes a comma-separated " +
        "list of +<tagId>/-<tagId> to add/remove tags without disturbing the others. Tag changes " +
        "and metadata changes are two separate requests (paperless-ngx has no combined endpoint) -- " +
        "if both are given and the second fails, the first has already applied; the error names " +
        "which step failed.",
    )
    .option("--title <title>", "New title.")
    .option("--correspondent <id>", "New correspondent id.")
    .option("--type <id>", "New document type id.")
    .option("--date <YYYY-MM-DD>", "New document date.")
    .option("--tag <delta>", "Comma-separated +<tagId>/-<tagId> list, e.g. +5,-3.")
    .addHelpText("after", "\nExample: ppl doc set 42 --correspondent 7 --tag +5,-3")
    .action(
      async (
        idArg: string,
        options: {
          title?: string;
          correspondent?: string;
          type?: string;
          date?: string;
          tag?: string;
        },
      ) => {
        if (
          options.title === undefined &&
          options.correspondent === undefined &&
          options.type === undefined &&
          options.date === undefined &&
          options.tag === undefined
        ) {
          throw new CliError("nothing to update", {
            exitCode: EXIT_CODES.usage,
            fix: "pass --title, --correspondent, --type, --date, and/or --tag",
          });
        }

        const id = parseId(idArg);
        const correspondentId =
          options.correspondent === undefined
            ? undefined
            : parseId(options.correspondent, "--correspondent");
        const typeId = options.type === undefined ? undefined : parseId(options.type, "--type");

        const { client, baseUrl } = resolveClientHandle();

        let tagsApplied = false;
        if (options.tag !== undefined) {
          const { add, remove } = parseTagDelta(options.tag);
          if (add.length > 0 || remove.length > 0) {
            await unwrapCli(
              client.POST("/api/documents/bulk_edit/", {
                body: {
                  documents: [id],
                  method: "modify_tags",
                  parameters: { add_tags: add, remove_tags: remove },
                },
              }),
            );
            tagsApplied = true;
          }
        }

        const hasMetadataChanges =
          options.title !== undefined ||
          correspondentId !== undefined ||
          typeId !== undefined ||
          options.date !== undefined;

        if (!hasMetadataChanges) {
          writeJson({ id, tagsUpdated: tagsApplied, url: `${baseUrl}/documents/${id}/details` });
          return;
        }

        let document: { id?: number; title?: string };
        try {
          document = await unwrapCli(
            client.PATCH("/api/documents/{id}/", {
              params: { path: { id } },
              body: {
                title: options.title,
                correspondent: correspondentId,
                document_type: typeId,
                created: options.date,
                remove_inbox_tags: false,
              },
            }),
          );
        } catch (error) {
          if (tagsApplied) {
            const message = error instanceof Error ? error.message : String(error);
            throw error instanceof CliError
              ? new CliError(`tags updated, but metadata update failed: ${message}`, {
                  exitCode: error.exitCode,
                  fix: error.fix,
                })
              : new Error(`tags updated, but metadata update failed: ${message}`);
          }
          throw error;
        }

        writeJson({
          id: document.id,
          title: document.title,
          url: `${baseUrl}/documents/${id}/details`,
        });
      },
    );

  addSubcommand(doc, "download <id>")
    .summary("Download a document's original file.")
    .option("--out <path>", "Write the file to this path.")
    .option("--original", "Download the original file, not the archived PDF version.")
    .addHelpText("after", "\nExample: ppl doc download 42 --out invoice.pdf")
    .action(async (idArg: string, options: { out?: string; original?: boolean }) => {
      if (options.out === undefined) {
        throw new CliError("missing --out <path>", { exitCode: EXIT_CODES.usage });
      }
      const id = parseId(idArg);
      const { client } = resolveClientHandle();
      const buffer = await unwrapCli(
        client.GET("/api/documents/{id}/download/", {
          params: { path: { id }, query: { original: options.original } },
          parseAs: "arrayBuffer",
        }),
      );
      writeFileSync(options.out, Buffer.from(buffer as ArrayBuffer));
      writeJson({ id, downloadedTo: options.out });
    });
}
