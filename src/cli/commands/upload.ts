import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  parseId,
  writeJson,
} from "@myceliumhq/toolkit";
import { unwrapCli } from "../api.js";
import { resolveClientHandle } from "../config.js";

function readFileOrThrow(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`cannot read file: ${message}`, { exitCode: EXIT_CODES.usage });
  }
}

export function registerUpload(program: Command): void {
  addSubcommand(program, "upload <file>")
    .summary("Upload a document for OCR/processing.")
    .description(
      "Upload a file to paperless-ngx's consume pipeline (OCR, then auto-tagging/matching). " +
        "Processing happens asynchronously -- this returns a task id, not a document id; the " +
        "document appears in `search`/`doc get` once processing finishes (usually a few seconds).",
    )
    .option("--title <title>", "Document title. Defaults to paperless-ngx's own inference.")
    .option("--correspondent <id>", "Correspondent id.")
    .option("--type <id>", "Document type id.")
    .option("--tags <ids>", "Comma-separated tag ids.")
    .addHelpText("after", "\nExample: ppl upload ./invoice.pdf --correspondent 7")
    .action(
      async (
        filePath: string,
        options: { title?: string; correspondent?: string; type?: string; tags?: string },
      ) => {
        // Validated up front (fails fast with a clean usage error) rather
        // than forwarding a bad value to the API and getting back a
        // generic server rejection mapped to exit 1.
        const correspondentId =
          options.correspondent === undefined
            ? undefined
            : parseId(options.correspondent, "--correspondent");
        const typeId = options.type === undefined ? undefined : parseId(options.type, "--type");
        const tagIds = (options.tags ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => parseId(t, "--tags entry"));

        const bytes = readFileOrThrow(filePath);
        const form = new FormData();
        // Buffer's ArrayBufferLike backing isn't assignable to Blob's
        // stricter ArrayBuffer-only BlobPart type -- copy into a plain
        // Uint8Array first rather than widening BlobPart's type.
        form.set("document", new Blob([new Uint8Array(bytes)]), basename(filePath));
        if (options.title !== undefined) form.set("title", options.title);
        if (correspondentId !== undefined) form.set("correspondent", String(correspondentId));
        if (typeId !== undefined) form.set("document_type", String(typeId));
        for (const tagId of tagIds) {
          form.append("tags", String(tagId));
        }

        const { client } = resolveClientHandle();
        const taskId = await unwrapCli(
          // @ts-expect-error -- openapi-fetch's generated body type is the
          // typed PostDocumentRequest object; passing a FormData directly
          // is the documented way to drive its multipart/form-data path
          // (it detects FormData and skips JSON.stringify + sets the
          // multipart boundary itself), which the strict generated type
          // doesn't model.
          client.POST("/api/documents/post_document/", { body: form }),
        );
        writeJson({ taskId, file: filePath });
      },
    );
}
