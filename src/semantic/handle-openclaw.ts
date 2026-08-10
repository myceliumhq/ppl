import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { PaperlessClientHandle } from "../client.js";
import {
  createSemanticSearchCore,
  type Logger,
  type SemanticSearchHandle,
  type SemanticSearchPluginConfig,
} from "./handle.js";

// The only OpenClaw-coupled module under src/semantic/ -- translates an
// OpenClawPluginApi into handle.ts's host-agnostic SemanticSearchHostDeps
// and calls its core setup logic. index.ts's register() imports from here.
// The standalone MCP server (../mcp-server.ts) imports handle.ts directly
// instead and never reaches this file, which is what keeps `openclaw` out
// of its module graph (verified by `pnpm run build` + grepping dist/ for
// `from "openclaw` -- see AGENTS.md).

// Mirrors index.ts's resolveApiToken (same SecretRef-or-plain-string
// shape, same resolution libraries), but tolerant rather than throwing:
// apiToken is a required field with no sensible "unset" behavior, whereas
// a missing/unresolvable embedding.apiKey just means the semantic backend
// stays unavailable (fail open) rather than a configuration error worth
// failing plugin setup over.
async function resolveApiKeyViaOpenClaw(
  api: OpenClawPluginApi,
  value: unknown,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!isSecretRef(value)) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  const resolved = await resolveSecretRefValues([value], { config: api.config });
  const [resolvedValue] = resolved.values();
  return typeof resolvedValue === "string" && resolvedValue.length > 0 ? resolvedValue : undefined;
}

function defaultIndexPath(): string {
  return path.join(os.homedir(), ".openclaw", "plugins", "paperless-ngx", "semantic-index.db");
}

// Builds the semantic-search backend the same way index.ts builds the
// paperless client handle: register() stays synchronous, this kicks off
// async setup without awaiting it, and hands back a promise every tool
// execute() can await once and reuse. `clientHandlePromise` is the same
// promise threaded into the paperless tools -- the source adapter awaits it
// internally rather than duplicating client construction.
export function createSemanticSearchHandle(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<PaperlessClientHandle>,
): Promise<SemanticSearchHandle> {
  const rawConfig = (
    api.pluginConfig as { semanticSearch?: SemanticSearchPluginConfig } | undefined
  )?.semanticSearch;
  // Falls back to a no-op logger rather than assuming api.logger is always
  // set -- register() must never throw or produce an unhandled rejection
  // just because logging is unavailable in whatever hosted this plugin.
  const logger: Logger = api.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  return createSemanticSearchCore(
    {
      config: rawConfig,
      logger,
      resolveApiKey: (value) => resolveApiKeyViaOpenClaw(api, value),
      defaultIndexPath,
      registerCleanup: (cleanup) =>
        api.lifecycle.registerRuntimeLifecycle({
          id: "paperless-ngx-semantic-search",
          description: "Closes the semantic search index on shutdown.",
          cleanup,
        }),
    },
    clientHandlePromise,
  );
}
