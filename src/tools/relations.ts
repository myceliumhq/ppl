import type { PaperlessClient } from "../client.js";
import { unwrap } from "../client.js";

const MAX_BATCH_SIZE = 100;

export type NamedTaxonomyEndpoint = "/api/tags/" | "/api/correspondents/" | "/api/document_types/";

// Batch-resolves a set of ids against a taxonomy endpoint in a single call
// (id__in) instead of one call per id. If more than MAX_BATCH_SIZE distinct
// ids are requested, only the first page resolves -- accepted as a rare edge
// case rather than looping pages for it.
export async function fetchNameMap(
  client: PaperlessClient,
  endpoint: NamedTaxonomyEndpoint,
  ids: number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const result = unwrap(
    await client.GET(endpoint, {
      params: { query: { id__in: ids, page_size: Math.min(ids.length, MAX_BATCH_SIZE) } },
    }),
  );
  const map = new Map<number, string>();
  for (const item of result.results ?? []) {
    if (typeof item.id === "number" && typeof item.name === "string") {
      map.set(item.id, item.name);
    }
  }
  return map;
}
