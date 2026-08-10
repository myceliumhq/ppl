import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient } from "../client.js";
import { createCreateTaxonomyTermTool, createListTaxonomyTool } from "./taxonomy.js";

const BASE_URL = "https://paperless.example.com";

type Route = {
  test: (pathname: string, method: string, url: URL) => boolean;
  handle: (request: Request) => unknown;
};

function stubFetch(routes: Route[]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const route = routes.find((r) => r.test(url.pathname, request.method, url));
    if (!route) {
      throw new Error(`Unhandled request in test: ${request.method} ${url.pathname}?${url.search}`);
    }
    return new Response(JSON.stringify(route.handle(request)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setup(routes: Route[]) {
  const fetchMock = stubFetch(routes);
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return { handle: Promise.resolve({ client, baseUrl: BASE_URL }), fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Every fixture below sets up exactly one result and expects it back --
// throwing here fails loudly if a fixture ever stops producing a result,
// instead of every assertion after it failing on undefined.
function firstResult(result: { details: unknown }): Record<string, unknown> {
  const item = (result.details as { results: Record<string, unknown>[] }).results[0];
  if (!item) throw new Error("test setup: expected at least one result");
  return item;
}

// Matches a taxonomy list GET (no id__in) -- as opposed to the id__in batch
// lookup fetchNameMap uses to resolve a tag's parent/children ids to names.
const listRoute = (endpoint: string, items: Record<string, unknown>[]): Route => ({
  test: (pathname, method, url) =>
    method === "GET" && pathname === endpoint && !url.searchParams.has("id__in"),
  handle: () => ({ count: items.length, results: items }),
});

// Matches fetchNameMap's id__in batch lookup against a taxonomy endpoint.
const nameLookupRoute = (endpoint: string, items: Record<string, unknown>[]): Route => ({
  test: (pathname, method, url) =>
    method === "GET" && pathname === endpoint && url.searchParams.has("id__in"),
  handle: () => ({ count: items.length, results: items }),
});

const createRoute = (endpoint: string, result: Record<string, unknown>): Route => ({
  test: (pathname, method) => method === "POST" && pathname === endpoint,
  handle: () => result,
});

describe("paperless_list_taxonomy", () => {
  it("lists tags and resolves parent/children ids to names", async () => {
    const { handle } = setup([
      listRoute("/api/tags/", [{ id: 1, name: "Travel", parent: 5, children: [2] }]),
      nameLookupRoute("/api/tags/", [
        { id: 5, name: "Categories" },
        { id: 2, name: "Flights" },
      ]),
    ]);
    const tool = createListTaxonomyTool(handle);
    const result = await tool.execute("call-1", { kind: "tag" });
    const tag = firstResult(result);
    expect(tag.parent_name).toBe("Categories");
    expect(tag.children_names).toEqual(["Flights"]);
  });

  it("lists correspondents flat, without attempting hierarchy resolution", async () => {
    const { handle } = setup([
      listRoute("/api/correspondents/", [{ id: 1, name: "Amazon", owner: 1, permissions: {} }]),
    ]);
    const tool = createListTaxonomyTool(handle);
    const result = await tool.execute("call-1", { kind: "correspondent" });
    const item = firstResult(result);
    expect(item.name).toBe("Amazon");
    expect(item.owner).toBeUndefined();
    expect(item.permissions).toBeUndefined();
    expect(item.parent_name).toBeUndefined();
  });

  it("lists document types flat", async () => {
    const { handle } = setup([listRoute("/api/document_types/", [{ id: 1, name: "Invoice" }])]);
    const tool = createListTaxonomyTool(handle);
    const result = await tool.execute("call-1", { kind: "document_type" });
    const item = firstResult(result);
    expect(item.name).toBe("Invoice");
  });

  it("filters by name_contains and clamps page_size at 100", async () => {
    const { handle, fetchMock } = setup([listRoute("/api/tags/", [])]);
    const tool = createListTaxonomyTool(handle);
    await tool.execute("call-1", { kind: "tag", name_contains: "trav", page_size: 5000 });
    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("name__icontains")).toBe("trav");
    expect(url.searchParams.get("page_size")).toBe("100");
  });

  it("passes through a page_size within the cap unchanged", async () => {
    const { handle, fetchMock } = setup([listRoute("/api/correspondents/", [])]);
    const tool = createListTaxonomyTool(handle);
    await tool.execute("call-1", { kind: "correspondent", page_size: 25 });
    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("page_size")).toBe("25");
  });
});

describe("paperless_create_taxonomy_term", () => {
  it("creates a tag with a parent and resolves parent_name in the response", async () => {
    const { handle, fetchMock } = setup([
      createRoute("/api/tags/", { id: 3, name: "Flights", parent: 5 }),
      nameLookupRoute("/api/tags/", [{ id: 5, name: "Travel" }]),
    ]);
    const tool = createCreateTaxonomyTermTool(handle);
    const result = await tool.execute("call-1", { kind: "tag", name: "Flights", parent_id: 5 });
    const doc = result.details as Record<string, unknown>;
    expect(doc.name).toBe("Flights");
    expect(doc.parent_name).toBe("Travel");

    // calls[0] is the POST create; calls[1] is fetchNameMap's follow-up GET
    // (id__in) to resolve parent_name, which has no JSON body.
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const body = await request.clone().json();
    expect(body).toEqual({ name: "Flights", parent: 5 });
  });

  it("creates a tag with no parent_id by sending parent: null", async () => {
    const { handle, fetchMock } = setup([createRoute("/api/tags/", { id: 3, name: "Misc" })]);
    const tool = createCreateTaxonomyTermTool(handle);
    await tool.execute("call-1", { kind: "tag", name: "Misc" });
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const body = await request.clone().json();
    expect(body).toEqual({ name: "Misc", parent: null });
  });

  it("creates a correspondent without a parent field in the request body", async () => {
    const { handle, fetchMock } = setup([
      createRoute("/api/correspondents/", { id: 9, name: "Acme Corp", owner: 1 }),
    ]);
    const tool = createCreateTaxonomyTermTool(handle);
    const result = await tool.execute("call-1", { kind: "correspondent", name: "Acme Corp" });
    const doc = result.details as Record<string, unknown>;
    expect(doc.name).toBe("Acme Corp");
    expect(doc.owner).toBeUndefined();

    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const body = await request.clone().json();
    expect(body).toEqual({ name: "Acme Corp" });
  });

  it("creates a document type without a parent field in the request body", async () => {
    const { handle, fetchMock } = setup([
      createRoute("/api/document_types/", { id: 4, name: "Receipt" }),
    ]);
    const tool = createCreateTaxonomyTermTool(handle);
    await tool.execute("call-1", { kind: "document_type", name: "Receipt" });
    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const body = await request.clone().json();
    expect(body).toEqual({ name: "Receipt" });
  });

  it("ignores parent_id when kind is not tag", async () => {
    const { handle, fetchMock } = setup([
      createRoute("/api/correspondents/", { id: 9, name: "Acme Corp" }),
    ]);
    const tool = createCreateTaxonomyTermTool(handle);
    await tool.execute("call-1", { kind: "correspondent", name: "Acme Corp", parent_id: 5 });
    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const body = await request.clone().json();
    expect(body).toEqual({ name: "Acme Corp" });
  });
});
