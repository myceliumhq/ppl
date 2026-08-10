import { CliError, EXIT_CODES } from "@myceliumhq/toolkit";
import { unwrap } from "../client.js";

// unwrap() (client.ts, shared with the MCP tool surface) throws a plain
// Error for any non-2xx API response -- correct for tools, but a CLI needs
// to tell a 404 apart from an auth failure or a network error so it can
// exit 3/4 per the documented contract instead of the generic 1. Mirrors
// apps/trilium/src/cli/etapi.ts's unwrapCli -- same pattern, this app's
// own client/error shape.
export async function unwrapCli<T>(
  resultPromise: Promise<{ data?: T; error?: unknown; response?: Response }>,
): Promise<T> {
  const result = await resultPromise;
  try {
    return unwrap(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = result.response?.status;
    if (status === 404) {
      throw new CliError(message, {
        exitCode: EXIT_CODES.notFound,
        fix: "check the id and try again",
      });
    }
    if (status === 401 || status === 403) {
      throw new CliError(message, { exitCode: EXIT_CODES.config, fix: "check PAPERLESS_TOKEN" });
    }
    throw error;
  }
}
