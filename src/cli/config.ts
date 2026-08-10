import { requireConfig } from "@myceliumhq/toolkit";
import { createPaperlessClient, type PaperlessClientHandle } from "../client.js";

export const CONFIG_SPEC = {
  baseUrl: { env: "PAPERLESS_URL", description: "Base URL of the paperless-ngx instance." },
  apiToken: { env: "PAPERLESS_TOKEN", description: "API token (My Profile in paperless-ngx)." },
} as const;

// Every command resolves the client the same way -- built lazily (not at
// module load) so `ppl --help` never requires PAPERLESS_URL/PAPERLESS_TOKEN
// to be set just to print usage.
export function resolveClientHandle(): PaperlessClientHandle {
  const { baseUrl, apiToken } = requireConfig(CONFIG_SPEC);
  const trimmed = baseUrl.replace(/\/+$/, "");
  return { client: createPaperlessClient({ baseUrl: trimmed, apiToken }), baseUrl: trimmed };
}
