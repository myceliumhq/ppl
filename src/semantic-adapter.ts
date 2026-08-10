import type { SourceAdapter } from "@myceliumhq/index";
import { createPaperlessClient } from "./client.js";
import { createPaperlessSourceAdapter } from "./semantic/source-adapter.js";

// Public, OpenClaw-agnostic entrypoint for external hosts (a generic
// semanticd sidecar) that want to sync this source without depending on
// the OpenClaw plugin registration in ./index.ts.
export {
  createPaperlessClient,
  type PaperlessClient,
  type PaperlessClientConfig,
} from "./client.js";
export { createPaperlessSourceAdapter } from "./semantic/source-adapter.js";

// Zero-argument factory matching semanticd's adapter-loader convention
// (SEMANTICD_ADAPTER_EXPORT defaults to "createAdapter") -- reads its own
// connection config from PAPERLESS_URL/PAPERLESS_TOKEN so semanticd itself
// never has to know this source exists, let alone how to configure it.
export function createAdapter(): SourceAdapter<number> {
  const baseUrl = process.env.PAPERLESS_URL;
  const apiToken = process.env.PAPERLESS_TOKEN;
  if (!baseUrl || !apiToken) {
    throw new Error("paperless-ngx semantic-adapter: missing PAPERLESS_URL and/or PAPERLESS_TOKEN");
  }
  const client = createPaperlessClient({ baseUrl, apiToken });
  return createPaperlessSourceAdapter(Promise.resolve(client));
}
