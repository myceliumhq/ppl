import { afterEach, describe, expect, it, vi } from "vitest";
import { createSemanticSearchCore, type Logger } from "./handle.js";

function stubLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warn: (message) => warnings.push(message),
    warnings,
  };
}

describe("createSemanticSearchCore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is unavailable when config.enabled is false, without touching the network", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const logger = stubLogger();

    const handle = createSemanticSearchCore({ config: { enabled: false }, logger });

    expect(handle.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable and warns when no semanticdUrl is configured", async () => {
    const logger = stubLogger();

    const handle = createSemanticSearchCore({ config: undefined, logger });

    expect(handle.available).toBe(false);
    expect(await handle.search("invoice", 5)).toEqual([]);
    expect(logger.warnings[0]).toMatch(/PAPERLESS_SEMANTICD_URL/);
  });

  it("queries semanticd and maps sourceId to a numeric documentId", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input as string);
      expect(url.pathname).toBe("/query");
      expect(url.searchParams.get("q")).toBe("invoice");
      expect(url.searchParams.get("limit")).toBe("5");
      return Response.json({
        query: "invoice",
        matches: [{ sourceId: "42", snippet: "a snippet", score: 0.5, startLine: 1, endLine: 2 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logger = stubLogger();

    const handle = createSemanticSearchCore({
      config: { semanticdUrl: "http://localhost:4499" },
      logger,
    });
    const matches = await handle.search("invoice", 5);

    expect(matches).toEqual([
      { documentId: 42, snippet: "a snippet", score: 0.5, startLine: 1, endLine: 2 },
    ]);
  });

  it("returns [] without querying for an empty search term", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const logger = stubLogger();

    const handle = createSemanticSearchCore({
      config: { semanticdUrl: "http://localhost:4499" },
      logger,
    });

    expect(await handle.search(undefined, 5)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to [] and warns when the semanticd query fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const logger = stubLogger();

    const handle = createSemanticSearchCore({
      config: { semanticdUrl: "http://localhost:4499" },
      logger,
    });

    expect(await handle.search("invoice", 5)).toEqual([]);
    expect(logger.warnings[0]).toMatch(/query against semanticd failed/);
  });
});
