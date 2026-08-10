import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
} from "@myceliumhq/embed";
import {
  DEFAULT_SEMANTIC_INDEX_CONFIG,
  openSemanticIndex,
  type SemanticIndex,
} from "@myceliumhq/index";
import type { PaperlessClientHandle } from "../client.js";
import { createPaperlessSourceAdapter } from "./source-adapter.js";
import type { SemanticMatch } from "./types.js";

// Host-agnostic on purpose: no import here reaches into `openclaw` at all
// (not even a type import), so this module is safe to pull into the
// standalone MCP server's module graph (../mcp-server.ts) without dragging
// openclaw in as a runtime dependency of a plain `node dist/mcp-server.js`
// install. The OpenClaw-specific plugin adapter lives in
// ./handle-openclaw.ts instead -- see its own comment.

// How often a background incremental sync pass runs. Not part of
// @myceliumhq/index's own config surface -- it doesn't manage scheduling
// itself, the host does.
const SYNC_INTERVAL_MS = 15 * 60_000;

export type SemanticSearchEmbeddingConfig = {
  // "local" is opt-in only -- never the silent default. A prior in-process
  // local-inference attempt (node-llama-cpp) was OOM-killed in production
  // on a memory-constrained host; see AGENTS.md.
  provider?: "openai-compatible" | "local";
  // Required for provider "openai-compatible" (any OpenAI-compatible
  // /v1/embeddings endpoint -- OpenAI, OpenRouter, Ollama, vLLM, LM
  // Studio, ...). Unused for "local".
  baseUrl?: string;
  // A plain string, or (only when resolved via the OpenClaw adapter in
  // ./handle-openclaw.ts) a SecretRef object -- see
  // SemanticSearchHostDeps.resolveApiKey.
  apiKey?: unknown;
  model?: string;
  dimensions?: number;
};

export type SemanticSearchPluginConfig = {
  enabled?: boolean;
  indexPath?: string;
  embedding?: SemanticSearchEmbeddingConfig;
};

export type Logger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

export type SemanticSearchHandle = {
  // False whenever the semantic backend couldn't come up for any reason
  // (disabled by config, embedding not fully configured, Node runtime
  // without node:sqlite, sqlite-vec failed to load, ...). `search` still
  // exists and is always safe to call -- it just always resolves to `[]`,
  // which is exactly the pre-existing stub behavior
  // paperless_search_documents already tolerates.
  available: boolean;
  search: (searchTerm: string | undefined, limit: number) => Promise<SemanticMatch[]>;
  dispose: () => Promise<void>;
};

function unavailableHandle(): SemanticSearchHandle {
  return {
    available: false,
    search: async () => [],
    dispose: async () => {},
  };
}

// Everything the setup logic below needs from whatever is hosting it.
// @myceliumhq/index and @myceliumhq/embed already have no OpenClaw dependency;
// this is the seam that keeps this module the same way.
export type SemanticSearchHostDeps = {
  config: SemanticSearchPluginConfig | undefined;
  // Resolves whatever `embedding.apiKey` actually is to a plain string (or
  // undefined if it can't be). ./handle-openclaw.ts resolves SecretRef
  // objects here; a standalone host has no SecretRef concept and can just
  // hand the value back when it's already a string.
  resolveApiKey: (value: unknown) => Promise<string | undefined>;
  logger: Logger;
  defaultIndexPath: () => string;
  registerCleanup: (cleanup: () => void | Promise<void>) => void;
};

// Resolves the configured embedding provider, or undefined (with a warning
// already logged) if there isn't enough config to build one -- never
// throws, since a missing/incomplete embedding config is exactly the
// "stay lexical-only" case, not a setup failure.
async function resolveEmbeddingProvider(
  deps: SemanticSearchHostDeps,
  raw: SemanticSearchEmbeddingConfig | undefined,
): Promise<EmbeddingProvider | undefined> {
  const provider = raw?.provider ?? "openai-compatible";

  if (provider === "local") {
    return createEmbeddingProvider({
      provider: "local",
      model: raw?.model,
      dimensions: raw?.dimensions,
    });
  }

  const apiKey = await deps.resolveApiKey(raw?.apiKey);
  if (!apiKey || !raw?.baseUrl || !raw?.model || !raw?.dimensions) {
    deps.logger.warn(
      "semantic search: embedding.baseUrl/apiKey/model/dimensions must all be configured for " +
        'the "openai-compatible" provider (or set embedding.provider to "local"), falling back ' +
        "to lexical-only search",
    );
    return undefined;
  }

  const config: EmbeddingProviderConfig = {
    provider: "openai-compatible",
    baseUrl: raw.baseUrl,
    apiKey,
    model: raw.model,
    dimensions: raw.dimensions,
  };
  return createEmbeddingProvider(config);
}

// The host-agnostic setup logic, shared by every host (OpenClaw plugin,
// standalone MCP server, ...): resolves an embedding provider, opens the
// index, wires up periodic sync. Never throws -- resolves to an
// unavailable handle on any failure so a caller can fail open to
// lexical-only search.
export function createSemanticSearchCore(
  deps: SemanticSearchHostDeps,
  clientHandlePromise: Promise<PaperlessClientHandle>,
): Promise<SemanticSearchHandle> {
  if (deps.config?.enabled === false) {
    return Promise.resolve(unavailableHandle());
  }

  return setup(deps, clientHandlePromise).catch((err) => {
    deps.logger.warn(
      `semantic search: setup failed, falling back to lexical-only search: ${describe(err)}`,
    );
    return unavailableHandle();
  });
}

async function setup(
  deps: SemanticSearchHostDeps,
  clientHandlePromise: Promise<PaperlessClientHandle>,
): Promise<SemanticSearchHandle> {
  const embeddingProvider = await resolveEmbeddingProvider(deps, deps.config?.embedding);
  if (!embeddingProvider) return unavailableHandle();

  const result = await openSemanticIndex({
    embeddingProvider,
    dbPath: deps.config?.indexPath ?? deps.defaultIndexPath(),
    ...DEFAULT_SEMANTIC_INDEX_CONFIG,
  });
  if (!result.available) {
    deps.logger.warn(
      `semantic search: index unavailable, falling back to lexical-only search: ${result.reason}`,
    );
    return unavailableHandle();
  }

  return setupWithOpenIndex(result.index, clientHandlePromise, deps);
}

function setupWithOpenIndex(
  index: SemanticIndex,
  clientHandlePromise: Promise<PaperlessClientHandle>,
  deps: SemanticSearchHostDeps,
): SemanticSearchHandle {
  const adapter = createPaperlessSourceAdapter(clientHandlePromise.then((h) => h.client));
  const { logger } = deps;

  let syncInFlight = false;
  const runSyncPass = async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      const summary = await index.sync(adapter, logger);
      logger.info?.(
        `semantic search: sync pass complete (processed=${summary.processed}, ` +
          `skipped=${summary.skippedUnchanged}, failed=${summary.failed})`,
      );
    } catch (err) {
      logger.warn(`semantic search: sync pass failed: ${describe(err)}`);
    } finally {
      syncInFlight = false;
    }
  };

  // Kick off an initial pass in the background rather than blocking tool
  // registration on a full backfill -- the first search after startup may
  // simply find nothing semantic yet, which is no worse than the
  // lexical-only behavior this replaces.
  void runSyncPass();

  const interval = setInterval(() => void runSyncPass(), SYNC_INTERVAL_MS);
  interval.unref?.();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    index.close();
  };

  deps.registerCleanup(dispose);

  return {
    available: true,
    search: async (searchTerm, limit) => {
      const matches = await index.search(searchTerm, limit, logger);
      return matches.map((match) => ({
        documentId: Number(match.sourceId),
        snippet: match.snippet,
        score: match.score,
        startLine: match.startLine,
        endLine: match.endLine,
      }));
    },
    dispose,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
