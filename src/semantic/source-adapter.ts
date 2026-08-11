import { createHash } from "node:crypto";
import type { SourceAdapter } from "@myceliumhq/index";
import type { PaperlessClient } from "../client.js";
import { unwrap } from "../client.js";
import { MAX_PAGE_SIZE } from "../tools/pagination.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// paperless-ngx's document list already returns `content` inline (no
// separate per-document fetch needed to compute a hash), unlike a source
// that only exposes a cheap pre-fetch hash (e.g. Trilium's blobId). Rather
// than fetch every changed document's content twice -- once here to hash
// it, again via fetchContent once the store confirms it actually changed --
// this caches what listChanged already fetched, for fetchContent to consume.
//
// Takes a client promise, not a resolved client, so constructing the
// adapter doesn't force awaiting apiToken resolution -- same lazy-resolve
// pattern as the rest of the plugin (see index.ts's createClientHandle).
export function createPaperlessSourceAdapter(
  clientPromise: Promise<PaperlessClient>,
): SourceAdapter<number> {
  const contentCache = new Map<number, string>();

  return {
    name: "paperless-ngx",

    async *listChanged(since) {
      const client = await clientPromise;
      // Ascending: @myceliumhq/index's sync loop sets its resumption
      // watermark to the *last* item of each page it processes (see
      // sync.ts's own doc comment) -- descending order would set the
      // watermark to the oldest doc in each page instead of the newest,
      // permanently excluding everything older than the very first backfill
      // page the moment modified__gte is applied.
      let page = 1;
      while (true) {
        const result = unwrap(
          await client.GET("/api/documents/", {
            params: {
              query: {
                ordering: "modified",
                modified__gte: since,
                page,
                page_size: MAX_PAGE_SIZE,
                fields: ["id", "modified", "content"],
              },
            },
          }),
        );

        const rows = Array.isArray(result.results)
          ? (result.results as Record<string, unknown>[])
          : [];
        if (rows.length === 0) return;

        for (const doc of rows) {
          if (typeof doc.id !== "number" || typeof doc.modified !== "string") continue;
          const content = typeof doc.content === "string" ? doc.content : "";
          contentCache.set(doc.id, content);
          yield { id: doc.id, contentHash: hashContent(content), modifiedAt: doc.modified };
        }

        if (!result.next) return;
        page += 1;
      }
    },

    // Deletion backstop for @myceliumhq/index's reconcile() -- paperless-ngx
    // has no delete trigger/webhook (only Added/Updated/Consumption), so a
    // removed document just stops appearing in listChanged with no
    // tombstone. This sweeps every live document id (no `content` field, so
    // it's cheap even at a few thousand documents) for reconcile() to diff
    // against what's stored.
    async *listAllIds() {
      const client = await clientPromise;
      let page = 1;
      while (true) {
        const result = unwrap(
          await client.GET("/api/documents/", {
            params: {
              query: {
                ordering: "id",
                page,
                page_size: MAX_PAGE_SIZE,
                fields: ["id"],
              },
            },
          }),
        );

        const rows = Array.isArray(result.results)
          ? (result.results as Record<string, unknown>[])
          : [];
        if (rows.length === 0) return;

        for (const doc of rows) {
          if (typeof doc.id === "number") yield doc.id;
        }

        if (!result.next) return;
        page += 1;
      }
    },

    async fetchContent(id) {
      const cached = contentCache.get(id);
      if (cached !== undefined) {
        contentCache.delete(id);
        return cached;
      }
      // Shouldn't normally happen -- runIncrementalSync calls fetchContent
      // shortly after listChanged yields the same id -- but fall back to a
      // direct fetch rather than assume the cache is authoritative.
      const client = await clientPromise;
      const result = unwrap(
        await client.GET("/api/documents/{id}/", {
          params: { path: { id }, query: { fields: ["content"] } },
        }),
      );
      return typeof result.content === "string" ? result.content : "";
    },
  };
}
