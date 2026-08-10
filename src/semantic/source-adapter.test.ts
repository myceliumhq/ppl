import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient } from "../client.js";
import { createPaperlessSourceAdapter } from "./source-adapter.js";

const BASE_URL = "https://paperless.example.com";

type Route = {
  test: (pathname: string, method: string) => boolean;
  handle: (request: Request) => unknown;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(routes: Route[]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const route = routes.find((r) => r.test(url.pathname, request.method));
    if (!route) throw new Error(`Unhandled request in test: ${request.method} ${url.pathname}`);
    return jsonResponse(route.handle(request));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function adapter() {
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return createPaperlessSourceAdapter(Promise.resolve(client));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPaperlessSourceAdapter", () => {
  it("yields id/contentHash/modifiedAt for every document across pages", async () => {
    const page1 = (docs: unknown[], next: string | null) => ({ count: 3, next, results: docs });
    const routes: Route[] = [
      {
        test: (p, m) => p === "/api/documents/" && m === "GET",
        handle: (req) => {
          const page = new URL(req.url).searchParams.get("page");
          if (page === "2") {
            return page1([{ id: 2, modified: "2026-01-01T00:00:00Z", content: "second" }], null);
          }
          return page1(
            [{ id: 1, modified: "2026-01-02T00:00:00Z", content: "first" }],
            `${BASE_URL}/api/documents/?page=2`,
          );
        },
      },
    ];

    stubFetch(routes);
    const sourceAdapter = adapter();
    const items = await collect(sourceAdapter.listChanged(undefined));

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 1, modifiedAt: "2026-01-02T00:00:00Z" });
    expect(items[1]).toMatchObject({ id: 2, modifiedAt: "2026-01-01T00:00:00Z" });
    // A real hex-encoded sha256 digest, not the raw content.
    expect(items[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends modified__gte (inclusive) when a watermark is given", async () => {
    const routes: Route[] = [
      {
        test: (p, m) => p === "/api/documents/" && m === "GET",
        handle: () => ({ count: 0, next: null, results: [] }),
      },
    ];
    const fetchMock = stubFetch(routes);
    const sourceAdapter = adapter();
    await collect(sourceAdapter.listChanged("2026-01-01T00:00:00Z"));

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("modified__gte")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("ordering")).toBe("-modified");
  });

  it("two documents with identical content hash the same, different content hashes differently", async () => {
    const routes: Route[] = [
      {
        test: (p, m) => p === "/api/documents/" && m === "GET",
        handle: () => ({
          count: 2,
          next: null,
          results: [
            { id: 1, modified: "2026-01-01T00:00:00Z", content: "same body" },
            { id: 2, modified: "2026-01-01T00:00:00Z", content: "same body" },
            { id: 3, modified: "2026-01-01T00:00:00Z", content: "different body" },
          ],
        }),
      },
    ];
    stubFetch(routes);
    const sourceAdapter = adapter();
    const items = await collect(sourceAdapter.listChanged(undefined));

    expect(items[0]?.contentHash).toBe(items[1]?.contentHash);
    expect(items[0]?.contentHash).not.toBe(items[2]?.contentHash);
  });

  it("fetchContent returns the content already fetched by listChanged, without a second request", async () => {
    const routes: Route[] = [
      {
        test: (p, m) => p === "/api/documents/" && m === "GET",
        handle: () => ({
          count: 1,
          next: null,
          results: [{ id: 1, modified: "2026-01-01T00:00:00Z", content: "cached body" }],
        }),
      },
      {
        test: (p, m) => p === "/api/documents/1/" && m === "GET",
        handle: () => {
          throw new Error("should not be called -- content was already cached");
        },
      },
    ];
    const fetchMock = stubFetch(routes);
    const sourceAdapter = adapter();
    await collect(sourceAdapter.listChanged(undefined));
    fetchMock.mockClear();

    const content = await sourceAdapter.fetchContent(1);
    expect(content).toBe("cached body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchContent falls back to a direct request when nothing is cached", async () => {
    const routes: Route[] = [
      {
        test: (p, m) => p === "/api/documents/42/" && m === "GET",
        handle: () => ({ content: "fetched directly" }),
      },
    ];
    stubFetch(routes);
    const sourceAdapter = adapter();

    const content = await sourceAdapter.fetchContent(42);
    expect(content).toBe("fetched directly");
  });
});
