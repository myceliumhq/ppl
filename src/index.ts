import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import { Type } from "typebox";
import { createPaperlessClient, type PaperlessClientHandle } from "./client.js";
import { createSemanticSearchHandle } from "./semantic/handle-openclaw.js";
import {
  createGetDocumentTool,
  createReadDocumentTool,
  createSearchDocumentContentTool,
  createSearchDocumentsTool,
  createUpdateDocumentTool,
} from "./tools/documents.js";
import { createCreateTaxonomyTermTool, createListTaxonomyTool } from "./tools/taxonomy.js";

// Manifest-facing schema: apiToken accepts a plain string OR a SecretRef
// object (e.g. `openclaw config set ... --ref-provider default --ref-source
// env --ref-id PAPERLESS_TOKEN`), matching how other secret-capable bundled
// plugins (e.g. brave's webSearch.apiKey) type their sensitive fields as
// `["string", "object"]` so config validation doesn't reject an unresolved
// ref at set-time. Despite the field being marked sensitive, OpenClaw does
// NOT resolve it before handing config to register() -- that has to happen
// explicitly, see resolveApiToken below.
const configSchema = Type.Object({
  baseUrl: Type.String({
    description: "Base URL of the paperless-ngx instance, e.g. https://paperless.example.com",
  }),
  apiToken: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
    description: "paperless-ngx API token, as a plain string or a SecretRef object",
  }),
  // No new tool/param exposes this -- it only tunes the plugin-owned
  // semantic index paperless_search_documents already folds in silently
  // (see src/semantic/ and the seam comment in src/tools/documents.ts).
  semanticSearch: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            "Enable the local semantic search index that hybridizes paperless_search_documents' " +
            "`search` results. Defaults to true; the plugin still fails open to lexical-only search " +
            "if the runtime/environment can't support it (e.g. Node <22.5, no node:sqlite) even when " +
            "this is left enabled.",
        }),
      ),
      indexPath: Type.Optional(
        Type.String({
          description:
            "Filesystem path for the plugin-owned SQLite+sqlite-vec index file. Defaults under " +
            "~/.openclaw/plugins/paperless-ngx/. The file is fully rebuildable from paperless-ngx " +
            "content, so it never needs its own backup strategy beyond copying this one file.",
        }),
      ),
      // Powered by @myceliumhq/embed -- any OpenAI-compatible /v1/embeddings
      // endpoint (OpenAI, OpenRouter, Ollama, vLLM, LM Studio, ...), or an
      // opt-in local CPU model. Without baseUrl+apiKey+model+dimensions (or
      // provider: "local"), the semantic index simply never comes up and
      // paperless_search_documents stays lexical-only (fail open), same as
      // any other unavailable-backend case.
      embedding: Type.Optional(
        Type.Object({
          provider: Type.Optional(
            Type.Union([Type.Literal("openai-compatible"), Type.Literal("local")], {
              description:
                'Embedding backend to use. Defaults to "openai-compatible". "local" runs a small ' +
                "ONNX model on-CPU via @myceliumhq/embed, with zero API dependency, but is never " +
                "chosen automatically -- opt in explicitly if you want document content to never " +
                "leave the machine.",
            }),
          ),
          baseUrl: Type.Optional(
            Type.String({
              description:
                'Base URL of an OpenAI-compatible embeddings endpoint, e.g. "https://openrouter.ai/api/v1". ' +
                'Required when provider is "openai-compatible" (the default); unused for "local".',
            }),
          ),
          // Same SecretRef-or-plain-string shape as the top-level apiToken
          // above, resolved the same way (see resolveApiKeyViaOpenClaw in
          // src/semantic/handle-openclaw.ts).
          apiKey: Type.Optional(
            Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
              description:
                "API key for the embedding endpoint, as a plain string or a SecretRef object. " +
                "Required for semantic search to do anything with the default openai-compatible " +
                "provider -- OCR content is sent to that endpoint to embed it. Without this (and no " +
                'provider: "local"), paperless_search_documents silently stays lexical-only.',
            }),
          ),
          model: Type.Optional(
            Type.String({
              description:
                "Embedding model id. Required for the openai-compatible provider (models vary by " +
                'endpoint, so there\'s no universal default); optional for "local" (defaults to a ' +
                "small bundled ONNX model).",
            }),
          ),
          dimensions: Type.Optional(
            Type.Integer({
              description:
                "Embedding vector width, must match what the configured model actually produces. " +
                'Required for the openai-compatible provider; optional for "local" (defaults to 384, ' +
                "matching its default model).",
            }),
          ),
        }),
      ),
    }),
  ),
});

async function resolveApiToken(api: OpenClawPluginApi, value: unknown): Promise<string> {
  if (!isSecretRef(value)) {
    return value as string;
  }
  const resolved = await resolveSecretRefValues([value], { config: api.config });
  const [resolvedValue] = resolved.values();
  if (typeof resolvedValue !== "string") {
    throw new Error("paperless-ngx: apiToken SecretRef did not resolve to a string");
  }
  return resolvedValue;
}

// register() must be synchronous (the host throws "plugin register must be
// synchronous" otherwise), so the client can't be built eagerly there when
// apiToken might be an unresolved SecretRef needing an async lookup.
// Instead, kick off resolution here without awaiting it and hand tools the
// in-flight promise -- each tool's execute() (already async) awaits it,
// resolving once and reusing the result for every subsequent call.
function createClientHandle(api: OpenClawPluginApi): Promise<PaperlessClientHandle> {
  const rawConfig = api.pluginConfig as { baseUrl: string; apiToken: unknown };
  const baseUrl = rawConfig.baseUrl.replace(/\/+$/, "");
  return resolveApiToken(api, rawConfig.apiToken).then((apiToken) => ({
    client: createPaperlessClient({ baseUrl: rawConfig.baseUrl, apiToken }),
    baseUrl,
  }));
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "paperless-ngx",
  name: "paperless-ngx",
  description:
    "Tools for retrieving (search, read, pattern-search) and updating documents in a paperless-ngx instance.",
  // TypeBox schemas are structurally JSON Schema but don't carry a string
  // index signature, which is all JsonSchemaObject adds on top of TSchema.
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  register(api) {
    const handle = createClientHandle(api);
    // Same pattern as the paperless client handle above: kicked off
    // without awaiting (register() must stay synchronous), resolves once,
    // and always resolves to *some* handle (never rejects) -- see
    // createSemanticSearchHandle's own doc comment for why setup failures
    // fail open instead of surfacing here.
    const semanticHandle = createSemanticSearchHandle(api, handle);

    api.registerTool(createSearchDocumentsTool(handle, semanticHandle));
    api.registerTool(createGetDocumentTool(handle));
    api.registerTool(createReadDocumentTool(handle));
    api.registerTool(createSearchDocumentContentTool(handle));
    api.registerTool(createUpdateDocumentTool(handle));
    api.registerTool(createListTaxonomyTool(handle));
    api.registerTool(createCreateTaxonomyTermTool(handle));
  },
});

export default entry;
