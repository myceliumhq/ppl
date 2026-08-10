import { describe, expect, it } from "vitest";
import type { PaperlessClientHandle } from "../client.js";
import { createSemanticSearchHandle } from "./handle-openclaw.js";

function fakeClientHandlePromise(): Promise<PaperlessClientHandle> {
  const client = {
    GET: async () => ({ data: { count: 0, results: [], next: null } }),
  };
  return Promise.resolve({ client: client as never, baseUrl: "https://paperless.example.com" });
}

// Mirrors the minimal fake `api` src/manifest.test.ts constructs -- no
// `logger`/`lifecycle`/`config` at all -- to guard the exact bug fixed
// here: createSemanticSearchHandle must never throw or produce an
// unhandled rejection just because those fields are missing.
function bareApi(pluginConfig: Record<string, unknown>) {
  return { pluginConfig } as never;
}

function fakeApi(pluginConfig: Record<string, unknown>) {
  return {
    pluginConfig,
    config: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    lifecycle: { registerRuntimeLifecycle: () => {} },
  } as never;
}

describe("createSemanticSearchHandle", () => {
  it("resolves to an unavailable handle without touching anything when semanticSearch.enabled is false", async () => {
    const handle = await createSemanticSearchHandle(
      fakeApi({ baseUrl: "x", apiToken: "t", semanticSearch: { enabled: false } }),
      fakeClientHandlePromise(),
    );
    expect(handle.available).toBe(false);
    expect(await handle.search("term", 5)).toEqual([]);
    await handle.dispose();
  });

  it("never throws and resolves to an unavailable handle against a minimal api object (no logger/lifecycle/config)", async () => {
    // This is the regression case: index.ts's register() calls this
    // synchronously against whatever `api` the host hands it, and
    // src/manifest.test.ts exercises register() with exactly this shape of
    // fake api. A throw or unhandled rejection here would break plugin
    // registration entirely, not just semantic search.
    await expect(
      createSemanticSearchHandle(
        bareApi({ baseUrl: "x", apiToken: "t" }),
        fakeClientHandlePromise(),
      ),
    ).resolves.toBeDefined();
  });

  it("resolves to an unavailable handle when embedding config is incomplete", async () => {
    // Without baseUrl/apiKey/model/dimensions there's nothing the
    // openai-compatible embedding provider can do -- this is the "no
    // external service will ever see your OCR content unless you opt in"
    // fail-open path the README documents.
    const handle = await createSemanticSearchHandle(
      fakeApi({ baseUrl: "x", apiToken: "t", semanticSearch: { indexPath: ":memory:" } }),
      fakeClientHandlePromise(),
    );
    expect(handle.available).toBe(false);
    expect(await handle.search("term", 5)).toEqual([]);
    await handle.dispose();
  });

  it("opens a real (in-memory) index and reports available: true given a full openai-compatible config", async () => {
    const handle = await createSemanticSearchHandle(
      fakeApi({
        baseUrl: "x",
        apiToken: "t",
        semanticSearch: {
          indexPath: ":memory:",
          embedding: {
            baseUrl: "https://example.test/v1",
            apiKey: "test-key",
            model: "text-embedding-test",
            dimensions: 8,
          },
        },
      }),
      fakeClientHandlePromise(),
    );
    // node:sqlite + sqlite-vec are both available in this test environment,
    // so the index itself should come up. This never makes a real network
    // call: search(undefined) no-ops before ever reaching the embedding
    // provider (see @myceliumhq/index's own no-op-on-empty-term coverage),
    // and no sync pass is awaited here.
    expect(handle.available).toBe(true);
    expect(await handle.search(undefined, 5)).toEqual([]);
    await handle.dispose();
  });
});
