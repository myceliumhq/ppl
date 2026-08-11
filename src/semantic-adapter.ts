import type { SourceAdapter } from "@myceliumhq/index";
import { createPaperlessClient } from "./client.js";
import { createPaperlessSourceAdapter } from "./semantic/source-adapter.js";

// Public entrypoint for external hosts that want to sync this source --
// bin/semanticd.ts passes createAdapter()'s return value straight into
// @myceliumhq/semanticd's runSemanticd().
export {
  createPaperlessClient,
  type PaperlessClient,
  type PaperlessClientConfig,
} from "./client.js";
export { createPaperlessSourceAdapter } from "./semantic/source-adapter.js";

// Zero-argument factory returning a ready SourceAdapter -- reads its own
// connection config from PAPERLESS_URL/PAPERLESS_TOKEN so the caller never
// has to know this source exists, let alone how to configure it.
export function createAdapter(): SourceAdapter<number> {
  const baseUrl = process.env.PAPERLESS_URL;
  const apiToken = process.env.PAPERLESS_TOKEN;
  if (!baseUrl || !apiToken) {
    throw new Error("paperless-ngx semantic-adapter: missing PAPERLESS_URL and/or PAPERLESS_TOKEN");
  }
  const client = createPaperlessClient({ baseUrl, apiToken });
  return createPaperlessSourceAdapter(Promise.resolve(client));
}
