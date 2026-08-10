import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  type BridgeableTool,
  createMcpServer,
  type HttpServerHandle,
  serveHttp,
  serveStdio,
} from "@myceliumhq/mcp";
import type { AnyAgentTool } from "./agent-tool.js";
import { createPaperlessClient, type PaperlessClientHandle } from "./client.js";
import { isLoopbackHost, readStandaloneConfig, readTransportConfig } from "./mcp-server-config.js";
import {
  createSemanticSearchCore,
  type Logger,
  type SemanticSearchHandle,
} from "./semantic/handle.js";
import {
  createGetDocumentTool,
  createReadDocumentTool,
  createSearchDocumentContentTool,
  createSearchDocumentsTool,
  createUpdateDocumentTool,
} from "./tools/documents.js";
import { filterReadOnlyTools } from "./tools/read-only.js";
import { createCreateTaxonomyTermTool, createListTaxonomyTool } from "./tools/taxonomy.js";

// MCP's stdio transport uses stdout exclusively for JSON-RPC framing --
// anything else written there corrupts the stream. Every log line here
// goes to stderr instead; this holds regardless of which transport ends up
// selected, so there's no branch to get wrong.
function stderrLogger(): Logger {
  const line = (level: string, message: string) =>
    console.error(`[paperless-ngx-mcp] ${level} ${message}`);
  return {
    info: (message) => line("INFO", message),
    warn: (message) => line("WARN", message),
    error: (message) => line("ERROR", message),
  };
}

function packageVersion(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
  return pkg.version;
}

function defaultIndexPath(): string {
  return path.join(os.homedir(), ".mycelium", "paperless-ngx", "semantic-index.db");
}

// The complete MCP tool surface -- extracted from main() so a test can
// import it (with stub handles) and assert against it without triggering
// main()'s process-level side effects (env parsing, listening, signal
// handlers). Also the drift-detection source of truth for
// tools/read-only.ts's classification: every name here must be classified
// as either read-only or write, and vice versa (see read-only.test.ts).
export function createAllTools(
  handlePromise: Promise<PaperlessClientHandle>,
  semanticHandlePromise: Promise<SemanticSearchHandle>,
): AnyAgentTool[] {
  return [
    createSearchDocumentsTool(handlePromise, semanticHandlePromise),
    createGetDocumentTool(handlePromise),
    createReadDocumentTool(handlePromise),
    createSearchDocumentContentTool(handlePromise),
    createUpdateDocumentTool(handlePromise),
    createListTaxonomyTool(handlePromise),
    createCreateTaxonomyTermTool(handlePromise),
  ];
}

async function main(): Promise<void> {
  const logger = stderrLogger();
  const config = readStandaloneConfig(process.env);

  const clientHandle: PaperlessClientHandle = {
    client: createPaperlessClient({ baseUrl: config.baseUrl, apiToken: config.apiToken }),
    baseUrl: config.baseUrl,
  };
  const handlePromise = Promise.resolve(clientHandle);

  const cleanupFns: Array<() => void | Promise<void>> = [];
  const semanticHandlePromise = createSemanticSearchCore(
    {
      config: config.semanticSearch,
      logger,
      // An env var is already either a plain string or nothing.
      resolveApiKey: async (value) =>
        typeof value === "string" && value.length > 0 ? value : undefined,
      defaultIndexPath,
      registerCleanup: (cleanup) => cleanupFns.push(cleanup),
    },
    handlePromise,
  );

  const allTools = createAllTools(handlePromise, semanticHandlePromise);

  // PAPERLESS_READ_ONLY=true is a hard trim, not a soft flag: the write tools
  // are never handed to createMcpServer, so they never show up in tools/list
  // and there's no handler behind them to call. Anything short of that
  // (annotating them, refusing at execute time) still leaves a live mutation
  // endpoint on a server whose whole point here is being remotely reachable
  // over HTTP.
  const tools = filterReadOnlyTools(allTools, config.readOnly);
  // Log the effective mode unconditionally, not only when read-only is on:
  // a read-write deployment that *meant* to be read-only but isn't is a
  // security misconfiguration, and it must be visible in the log from boot --
  // not silently indistinguishable from an intended read-write server.
  logger.info?.(
    `read-only mode ${config.readOnly ? "ON" : "off"}: registering ${tools.length} of ${allTools.length} tools`,
  );

  // AnyAgentTool.parameters is a TypeBox TSchema -- structurally a plain
  // JSON Schema object at runtime (which is all BridgeableTool actually
  // needs), but TSchema declares no string index signature, so it doesn't
  // structurally satisfy Record<string, unknown> on its own.

  const transportConfig = readTransportConfig(process.env);
  if (transportConfig.transport === "http" && !isLoopbackHost(transportConfig.host)) {
    // The app has no built-in auth by design (Caddy/h3 sits in front). Binding a
    // non-loopback interface is an exposure switch, so surface a loud boot-time
    // warning rather than relying on README prose an operator may skip.
    logger.warn?.(
      `binding on non-loopback interface ${transportConfig.host}: the app has no built-in auth; ` +
        "only expose behind an authenticated reverse proxy and prefer read-only mode",
    );
  }
  let httpHandle: HttpServerHandle | undefined;
  if (transportConfig.transport === "http") {
    // Streamable HTTP mounts one Server per session, so hand over a factory.
    httpHandle = await serveHttp(
      () =>
        createMcpServer(tools as unknown as BridgeableTool[], {
          name: "paperless-ngx",
          version: packageVersion(),
        }),
      {
        port: transportConfig.port,
        host: transportConfig.host,
        allowedHosts: transportConfig.allowedHosts,
      },
    );
    logger.info?.(`listening on ${httpHandle.host}:${httpHandle.port}/mcp`);
  } else {
    // Only the stdio path needs a standalone, eagerly-created Server.
    const server = createMcpServer(tools as unknown as BridgeableTool[], {
      name: "paperless-ngx",
      version: packageVersion(),
    });
    await serveStdio(server);
    logger.info?.("listening on stdio");
  }

  const shutdown = async (signal: string) => {
    logger.info?.(`received ${signal}, shutting down`);
    await Promise.all(cleanupFns.map((cleanup) => cleanup()));
    await httpHandle?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only run main() when this file is executed directly (node dist/mcp-server.js),
// not when imported for its createAllTools export -- e.g. read-only.test.ts
// imports this module to get the real tool list without wanting to boot a
// server or parse env vars as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
