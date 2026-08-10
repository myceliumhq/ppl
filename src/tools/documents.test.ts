import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient } from "../client.js";
import type { SemanticSearchHandle } from "../semantic/handle.js";
import type { SemanticMatch } from "../semantic/types.js";
import {
  createGetDocumentTool,
  createReadDocumentTool,
  createSearchDocumentContentTool,
  createSearchDocumentsTool,
  createUpdateDocumentTool,
} from "./documents.js";

// Every test not specifically about the semantic hybrid merge uses this --
// `available: false` with an empty search result is exactly what a real
// handle resolves to when the backend couldn't come up (see
// src/semantic/handle.ts's unavailableHandle), so these tests exercise the
// same fail-open path paperless_search_documents falls back to in practice.
function noSemanticHandle(): Promise<SemanticSearchHandle> {
  return Promise.resolve({
    available: false,
    search: async () => [],
    dispose: async () => {},
  });
}

function fakeSemanticHandle(matches: SemanticMatch[]): Promise<SemanticSearchHandle> {
  return Promise.resolve({
    available: true,
    search: async () => matches,
    dispose: async () => {},
  });
}

// Every single-document test fixture sets up exactly one result and expects
// it back -- throwing here (rather than a bare `results[0]!`) fails loudly
// if a test's own route fixture ever stops producing a result, instead of
// every assertion after it failing with a confusing "Cannot read property
// of undefined".
function firstResult(result: { details: unknown }): Record<string, unknown> {
  const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
  if (!doc) throw new Error("test setup: expected at least one result");
  return doc;
}

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
    if (!route) {
      throw new Error(`Unhandled request in test: ${request.method} ${url.pathname}`);
    }
    return jsonResponse(route.handle(request));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setup(routes: Route[]) {
  stubFetch(routes);
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return Promise.resolve({ client, baseUrl: BASE_URL });
}

// Like `setup`, but also hands back the underlying fetch mock so a test can
// inspect the outgoing request (query params) rather than just the shaped
// response.
function setupWithSpy(routes: Route[]) {
  const fetchMock = stubFetch(routes);
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return { handle: Promise.resolve({ client, baseUrl: BASE_URL }), fetchMock };
}

function lastRequestUrl(fetchMock: ReturnType<typeof stubFetch>): URL {
  const call = fetchMock.mock.calls.at(-1);
  const request = call?.[0] as Request;
  return new URL(request.url);
}

const documentsListRoute = (docs: Record<string, unknown>[]): Route => ({
  test: (pathname, method) => method === "GET" && pathname === "/api/documents/",
  handle: () => ({ count: docs.length, results: docs }),
});

const documentGetRoute = (docsById: Record<number, Record<string, unknown>>): Route => ({
  test: (pathname, method) => method === "GET" && /^\/api\/documents\/\d+\/$/.test(pathname),
  handle: (request) => {
    const id = Number(new URL(request.url).pathname.split("/")[3]);
    const doc = docsById[id];
    if (!doc) throw new Error(`test: no fixture for document id ${id}`);
    return doc;
  },
});

// The update tool PATCHes and echoes back whatever this returns -- callers
// pass the same fixture the PATCH "changed" so the shaped response reflects
// the (fake) post-update state, same as the real API would.
const documentPatchRoute = (doc: Record<string, unknown>): Route => ({
  test: (pathname, method) => method === "PATCH" && /^\/api\/documents\/\d+\/$/.test(pathname),
  handle: () => doc,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILLER_A = "A".repeat(300);
const FILLER_B = "B".repeat(300);
const MARKER = "INVOICE-2024-0042";
const SAMPLE_CONTENT = `${FILLER_A} ${MARKER} ${FILLER_B}`;

describe("paperless_search_documents content policy", () => {
  it("omits content by default when no search/query is given", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", {});
    const doc = firstResult(result);
    expect(doc.content).toBeUndefined();
    expect(doc.content_snippet).toBeUndefined();
    expect(doc.title).toBe("Doc 1");
  });

  it("never returns content, even if `fields` explicitly lists it", async () => {
    // search_documents has no way to request full content at all -- the
    // client-side content policy strips `content` from every result
    // regardless of what `fields` asked the API for, so there's no way to
    // get full text back from a search call. Use
    // paperless_get_document/read_document/search_document_content instead.
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { fields: ["id", "title", "content"] });
    const doc = firstResult(result);
    expect(doc.content).toBeUndefined();
  });

  it("adds a content_snippet around the search term when content is omitted", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { search: MARKER });
    const doc = firstResult(result);
    expect(doc.content).toBeUndefined();
    expect(typeof doc.content_snippet).toBe("string");
    expect(doc.content_snippet as string).toContain(MARKER);
    expect((doc.content_snippet as string).length).toBeLessThan(SAMPLE_CONTENT.length);
  });

  it("strips whoosh query syntax down to bare words when building a snippet from `query`", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { query: `content:"${MARKER}" AND type:Invoice` });
    const doc = firstResult(result);
    expect(doc.content_snippet as string).toContain(MARKER);
  });

  it("falls back to a leading excerpt when the search term isn't found in content", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { search: "totally-absent-term" });
    const doc = firstResult(result);
    expect(doc.content).toBeUndefined();
    const snippet = doc.content_snippet as string;
    expect(snippet.startsWith(FILLER_A.slice(0, 20))).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("matches a wildcard Whoosh query fragment when building a snippet", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    // "INVOI*42" -- the literal wildcard would never match OCR text, but the
    // "INVOI" fragment (before the `*`) is a real substring of MARKER.
    const result = await tool.execute("call-1", { query: "INVOI*42" });
    const doc = firstResult(result);
    const snippet = doc.content_snippet as string;
    expect(snippet).toContain(MARKER);
  });

  it("keeps an emoji intact when it straddles a snippet boundary", async () => {
    // An emoji is a UTF-16 surrogate pair; place it so the snippet's
    // char-count boundary (SNIPPET_CONTEXT_CHARS = 160 after the match)
    // would fall between its two halves if slicing weren't surrogate-aware.
    const emoji = "\u{1F600}";
    const fillerLen = 159 - MARKER.length;
    const content = `${MARKER}${"x".repeat(fillerLen)}${emoji}${"y".repeat(50)}`;
    const handle = setup([documentsListRoute([{ id: 1, title: "Doc 1", content, tags: [] }])]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { search: MARKER });
    const doc = firstResult(result);
    const snippet = doc.content_snippet as string;
    expect(snippet).toContain(emoji);
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("keeps an emoji intact when it straddles the leading-excerpt boundary", async () => {
    const emoji = "\u{1F600}";
    const fillerLen = 319;
    const content = `${"x".repeat(fillerLen)}${emoji}${"y".repeat(50)}`;
    const handle = setup([documentsListRoute([{ id: 1, title: "Doc 1", content, tags: [] }])]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { search: "absent-term" });
    const doc = firstResult(result);
    const snippet = doc.content_snippet as string;
    expect(snippet).toContain(emoji);
  });

  it("returns lexical results unchanged when the semantic backend is unavailable", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    const result = await tool.execute("call-1", { search: MARKER });
    const results = (result.details as { results: Record<string, unknown>[] }).results;
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(1);
  });
});

describe("paperless_search_documents semantic hybrid merge", () => {
  it("upgrades content_snippet for a lexical document that also matched semantically", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const semantic = fakeSemanticHandle([
      {
        documentId: 1,
        snippet: "a more targeted semantic excerpt",
        score: 0.9,
        startLine: 12,
        endLine: 20,
      },
    ]);
    const tool = createSearchDocumentsTool(handle, semantic);
    const result = await tool.execute("call-1", { search: MARKER });
    const results = (result.details as { results: Record<string, unknown>[] }).results;
    expect(results).toHaveLength(1);
    expect(results[0]?.content_snippet).toBe("a more targeted semantic excerpt");
    // The matched chunk's line span rides along so a caller can jump
    // straight to it with paperless_read_document instead of reading from
    // the start of a possibly-long document.
    expect(results[0]?.content_snippet_start_line).toBe(12);
    expect(results[0]?.content_snippet_end_line).toBe(20);
  });

  it("fetches, shapes, and folds in a semantic-only document not in the lexical page", async () => {
    // One route, branching on id__in -- the batched semantic-only fetch
    // (id__in=2) needs a different fixture than the main search call.
    const route = {
      test: (pathname: string, method: string) =>
        method === "GET" && pathname === "/api/documents/",
      handle: (request: Request) => {
        const url = new URL(request.url);
        if (url.searchParams.has("id__in")) {
          return { count: 1, results: [{ id: 2, title: "Doc 2", content: "unrelated", tags: [] }] };
        }
        return {
          count: 1,
          results: [{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }],
        };
      },
    };
    const handle = setup([route]);
    const semantic = fakeSemanticHandle([
      { documentId: 2, snippet: "semantic-only hit", score: 0.95, startLine: 3, endLine: 9 },
    ]);
    const tool = createSearchDocumentsTool(handle, semantic);
    const result = await tool.execute("call-1", { search: MARKER });
    const results = (result.details as { results: Record<string, unknown>[] }).results;

    expect(results.map((doc) => doc.id)).toEqual(expect.arrayContaining([1, 2]));
    const semanticOnlyDoc = results.find((doc) => doc.id === 2);
    expect(semanticOnlyDoc?.content_snippet).toBe("semantic-only hit");
    expect(semanticOnlyDoc?.content_snippet_start_line).toBe(3);
    expect(semanticOnlyDoc?.content_snippet_end_line).toBe(9);
    // Shaped the same way lexical results are -- gets a `url` into the web UI.
    expect(semanticOnlyDoc?.url).toBe(`${BASE_URL}/documents/2/details`);
  });

  it("ranks a strong semantic-only hit above a weak lexical tail match (RRF)", async () => {
    const lexicalDocs = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      title: `Doc ${i + 1}`,
      content: SAMPLE_CONTENT,
      tags: [],
    }));
    const route = {
      test: (pathname: string, method: string) =>
        method === "GET" && pathname === "/api/documents/",
      handle: (request: Request) => {
        const url = new URL(request.url);
        if (url.searchParams.has("id__in")) {
          return {
            count: 1,
            results: [{ id: 99, title: "Semantic winner", content: "x", tags: [] }],
          };
        }
        return { count: lexicalDocs.length, results: lexicalDocs };
      },
    };
    const handle = setup([route]);
    // Best possible semantic rank (1st) for a document absent from the
    // lexical page at all: RRF score 1/(60+1) ~= 0.01639. The lexical
    // page's worst-ranked (5th) entry scores 1/(60+5) ~= 0.01538 -- lower,
    // so it's the one that should get displaced once the merged list is
    // capped back down to page_size.
    const semantic = fakeSemanticHandle([
      { documentId: 99, snippet: "top semantic match", score: 0.99, startLine: 1, endLine: 8 },
    ]);
    const tool = createSearchDocumentsTool(handle, semantic);
    const result = await tool.execute("call-1", { search: MARKER, page_size: 5 });
    const results = (result.details as { results: Record<string, unknown>[] }).results;

    expect(results).toHaveLength(5);
    expect(results.some((doc) => doc.id === 99)).toBe(true);
    // The weakest lexical entry (rank 5) lost its spot to the stronger
    // semantic-only hit -- the response still obeys page_size rather than
    // growing to fit every semantic addition.
    expect(results.some((doc) => doc.id === 5)).toBe(false);
    expect(results[0]?.id).toBe(1);
  });

  it("passes params.search -- never params.query -- to the semantic handle", async () => {
    // The stub-era doc comment on fetchSemanticMatches was explicit that
    // only the free-text `search` term is ever embedded, never `query`
    // (paperless-ngx's own Whoosh syntax) -- deliberate, so this asserts
    // it's still true against the real implementation's call site.
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const seenTerms: (string | undefined)[] = [];
    const semantic: Promise<SemanticSearchHandle> = Promise.resolve({
      available: true,
      search: async (searchTerm) => {
        seenTerms.push(searchTerm);
        return [];
      },
      dispose: async () => {},
    });
    const tool = createSearchDocumentsTool(handle, semantic);
    await tool.execute("call-1", { query: `content:"${MARKER}"` });
    expect(seenTerms).toEqual([undefined]);
  });

  it("still calls the semantic handle with an undefined term on a pure filter/browse call", async () => {
    // paperless_search_documents' own no-op-on-empty-term guarantee lives
    // inside searchSemantic (see src/semantic/search.test.ts) -- this only
    // asserts the call site here threads params.search through as-is
    // (undefined for a filter-only call) rather than substituting
    // something else.
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const seenTerms: (string | undefined)[] = [];
    const semantic: Promise<SemanticSearchHandle> = Promise.resolve({
      available: true,
      search: async (searchTerm) => {
        seenTerms.push(searchTerm);
        return [];
      },
      dispose: async () => {},
    });
    const tool = createSearchDocumentsTool(handle, semantic);
    await tool.execute("call-1", { tag_id: 7 });
    expect(seenTerms).toEqual([undefined]);
  });
});

describe("paperless_get_document content policy", () => {
  it("omits content by default", async () => {
    const handle = setup([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBeUndefined();
    expect(doc.content_snippet).toBeUndefined();
  });

  it("never returns raw content, even if `fields` lists it, without excerpt_search", async () => {
    const handle = setup([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, fields: ["id", "title", "content"] });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBeUndefined();
  });

  it("returns a content_snippet around excerpt_search when given", async () => {
    const handle = setup([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, excerpt_search: MARKER });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBeUndefined();
    expect(typeof doc.content_snippet).toBe("string");
    expect(doc.content_snippet as string).toContain(MARKER);
  });
});

describe("outgoing request serialization", () => {
  it("search_documents sends `search` in the request query", async () => {
    const { handle, fetchMock } = setupWithSpy([documentsListRoute([])]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    await tool.execute("call-1", { search: "invoice" });
    expect(lastRequestUrl(fetchMock).searchParams.get("search")).toBe("invoice");
  });

  it("search_documents sends `fields` as given", async () => {
    const { handle, fetchMock } = setupWithSpy([
      documentsListRoute([{ id: 1, title: "Doc 1", tags: [] }]),
    ]);
    const tool = createSearchDocumentsTool(handle, noSemanticHandle());
    await tool.execute("call-1", { fields: ["id", "title"] });
    const fields = lastRequestUrl(fetchMock).searchParams.get("fields");
    expect(fields?.split(",")).toEqual(["id", "title"]);
  });

  it("get_document adds `content` to `fields` in the request when excerpt_search is given", async () => {
    const { handle, fetchMock } = setupWithSpy([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    await tool.execute("call-1", { id: 1, fields: ["id", "title"], excerpt_search: MARKER });
    const fields = lastRequestUrl(fetchMock).searchParams.get("fields");
    expect(fields?.split(",")).toEqual(expect.arrayContaining(["id", "title", "content"]));
  });
});

const GREP_CONTENT = [
  "Policy Number: ABC-123",
  "Effective Date: 2024-01-01",
  "Premium: $500.00",
  "Coverage: Comprehensive",
  "Policy Number: XYZ-999",
  "End of document",
].join("\n");

describe("paperless_search_document_content", () => {
  it("returns matching lines with surrounding context", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "Policy Number" });
    const details = result.details as {
      total_lines: number;
      total_matches: number;
      truncated: boolean;
      matches: { line_number: number; line: string; context: string }[];
    };
    expect(details.total_lines).toBe(6);
    expect(details.total_matches).toBe(2);
    expect(details.truncated).toBe(false);
    expect(details.matches).toHaveLength(2);
    expect(details.matches[0]?.line_number).toBe(1);
    expect(details.matches[0]?.line).toBe("Policy Number: ABC-123");
    // context_lines defaults to 2, clipped at the top of the document
    expect(details.matches[0]?.context).toBe(
      ["Policy Number: ABC-123", "Effective Date: 2024-01-01", "Premium: $500.00"].join("\n"),
    );
    expect(details.matches[1]?.line_number).toBe(5);
  });

  it("caps returned matches at max_matches and reports truncated", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", {
      id: 1,
      pattern: "Policy Number",
      max_matches: 1,
    });
    const details = result.details as {
      total_matches: number;
      matches: unknown[];
      truncated: boolean;
    };
    expect(details.matches).toHaveLength(1);
    expect(details.total_matches).toBe(2);
    expect(details.truncated).toBe(true);
  });

  it("is case-insensitive by default and honors ignore_case: false", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);

    const caseInsensitive = await tool.execute("call-1", { id: 1, pattern: "policy number" });
    expect((caseInsensitive.details as { total_matches: number }).total_matches).toBe(2);

    const caseSensitive = await tool.execute("call-2", {
      id: 1,
      pattern: "policy number",
      ignore_case: false,
    });
    expect((caseSensitive.details as { total_matches: number }).total_matches).toBe(0);
  });

  it("throws a clear error on an invalid regex pattern", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    await expect(tool.execute("call-1", { id: 1, pattern: "(" })).rejects.toThrow(
      /invalid pattern/,
    );
  });

  it("rejects patterns with too many repetition operators (ReDoS guard)", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    const pathological = "a+".repeat(20);
    await expect(tool.execute("call-1", { id: 1, pattern: pathological })).rejects.toThrow(
      /too many repetition operators/,
    );
  });

  it("rejects patterns longer than the length cap", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    const tooLong = "a".repeat(501);
    await expect(tool.execute("call-1", { id: 1, pattern: tooLong })).rejects.toThrow(
      /longer than 500 characters/,
    );
  });

  it("normalizes CRLF line endings before matching", async () => {
    const crlfContent = GREP_CONTENT.split("\n").join("\r\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: crlfContent } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "Policy Number" });
    const details = result.details as {
      total_matches: number;
      matches: { line: string; context: string }[];
    };
    expect(details.total_matches).toBe(2);
    expect(details.matches[0]?.line).toBe("Policy Number: ABC-123");
    expect(details.matches[0]?.line).not.toContain("\r");
    expect(details.matches[0]?.context).not.toContain("\r");
  });

  it("reports content_status: null and skips the search when content is missing", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: null } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "anything" });
    const details = result.details as {
      total_lines: number;
      total_matches: number;
      matches: unknown[];
      content_status: string;
    };
    expect(details.content_status).toBe("null");
    expect(details.total_lines).toBe(0);
    expect(details.total_matches).toBe(0);
    expect(details.matches).toEqual([]);
  });

  it("reports content_status: present when a match is found", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "Policy Number" });
    expect((result.details as { content_status: string }).content_status).toBe("present");
  });

  it("reports content_status: empty when content is an empty string", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: "" } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "anything" });
    const details = result.details as { content_status: string; total_matches: number };
    expect(details.content_status).toBe("empty");
    expect(details.total_matches).toBe(0);
  });

  it("returns zero matches (not an error) when the pattern matches nothing", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "no-such-term-xyz" });
    const details = result.details as {
      content_status: string;
      total_matches: number;
      matches: unknown[];
      truncated: boolean;
    };
    expect(details.content_status).toBe("present");
    expect(details.total_matches).toBe(0);
    expect(details.matches).toEqual([]);
    expect(details.truncated).toBe(false);
  });

  it("handles a single very long line with no newlines", async () => {
    const longLine = `prefix ${"word ".repeat(2000)}needle ${"word ".repeat(2000)}suffix`;
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longLine } })]);
    const tool = createSearchDocumentContentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "needle" });
    const details = result.details as {
      total_lines: number;
      total_matches: number;
      matches: { line_number: number; line: string }[];
    };
    expect(details.total_lines).toBe(1);
    expect(details.total_matches).toBe(1);
    expect(details.matches[0]?.line_number).toBe(1);
    expect(details.matches[0]?.line).toBe(longLine);
  });
});

describe("paperless_read_document", () => {
  const rangeContent = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");

  it("defaults to the start of the document", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as {
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    };
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(10);
    expect(details.total_lines).toBe(10);
    expect(details.content).toBe(rangeContent);
  });

  it("returns an explicit line range", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 3, end_line: 5 });
    const details = result.details as { start_line: number; end_line: number; content: string };
    expect(details.start_line).toBe(3);
    expect(details.end_line).toBe(5);
    expect(details.content).toBe("Line 3\nLine 4\nLine 5");
  });

  it("returns an empty range past the end of the document", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 50 });
    const details = result.details as {
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    };
    expect(details.start_line).toBe(50);
    expect(details.end_line).toBe(49);
    expect(details.total_lines).toBe(10);
    expect(details.content).toBe("");
  });

  it("caps the requested span at 500 lines", async () => {
    const longContent = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`).join("\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 1, end_line: 1000 });
    const details = result.details as { start_line: number; end_line: number; content: string };
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(500);
    expect(details.content.split("\n")).toHaveLength(500);
  });

  it("caps a default (no explicit range) read at 500 lines on a long document", async () => {
    // This is the case that used to be paperless_get_document(include_content: true) --
    // just calling with an id and nothing else should behave the same as
    // reading from the start, bounded the same way.
    const longContent = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`).join("\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as { start_line: number; end_line: number; total_lines: number };
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(200);
    expect(details.total_lines).toBe(600);
  });

  it("normalizes CRLF line endings before slicing", async () => {
    const crlfContent = rangeContent.split("\n").join("\r\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: crlfContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 3, end_line: 5 });
    const details = result.details as { content: string };
    expect(details.content).toBe("Line 3\nLine 4\nLine 5");
    expect(details.content).not.toContain("\r");
  });

  it("reports content_status: null and returns empty content when content is missing", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: null } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as {
      total_lines: number;
      content: string;
      content_status: string;
    };
    expect(details.content_status).toBe("null");
    expect(details.total_lines).toBe(0);
    expect(details.content).toBe("");
  });

  it("reports content_status: present for a normal range", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    expect((result.details as { content_status: string }).content_status).toBe("present");
  });

  it("throws a clear error on an inverted range (end_line before start_line)", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createReadDocumentTool(handle);
    await expect(tool.execute("call-1", { id: 1, start_line: 10, end_line: 2 })).rejects.toThrow(
      /end_line \(2\) is before start_line \(10\)/,
    );
  });

  it("handles a single very long line with no newlines", async () => {
    const longLine = "word ".repeat(5000).trim();
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longLine } })]);
    const tool = createReadDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as {
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    };
    expect(details.total_lines).toBe(1);
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(1);
    expect(details.content).toBe(longLine);
  });
});

describe("paperless_update_document content policy", () => {
  it("omits content by default", async () => {
    const handle = setup([
      documentPatchRoute({ id: 1, title: "New Title", content: SAMPLE_CONTENT, tags: [] }),
    ]);
    const tool = createUpdateDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, title: "New Title" });
    const doc = result.details as Record<string, unknown>;
    expect(doc.title).toBe("New Title");
    expect(doc.content).toBeUndefined();
  });

  it("includes content when `fields` explicitly lists it", async () => {
    const handle = setup([
      documentPatchRoute({ id: 1, title: "New Title", content: SAMPLE_CONTENT, tags: [] }),
    ]);
    const tool = createUpdateDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, title: "New Title", fields: ["content"] });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBe(SAMPLE_CONTENT);
  });

  it("caps content at 500 lines and reports content_truncated/content_total_lines even though `fields` didn't ask for them", async () => {
    const longContent = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`).join("\n");
    const handle = setup([
      documentPatchRoute({ id: 1, title: "New Title", content: longContent, tags: [] }),
    ]);
    const tool = createUpdateDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, title: "New Title", fields: ["content"] });
    const doc = result.details as Record<string, unknown>;
    expect((doc.content as string).split("\n")).toHaveLength(500);
    expect(doc.content_truncated).toBe(true);
    expect(doc.content_total_lines).toBe(600);
  });

  it("still omits content when `fields` is given but doesn't list content", async () => {
    const handle = setup([
      documentPatchRoute({ id: 1, title: "New Title", content: SAMPLE_CONTENT, tags: [] }),
    ]);
    const tool = createUpdateDocumentTool(handle);
    const result = await tool.execute("call-1", {
      id: 1,
      title: "New Title",
      fields: ["title"],
    });
    const doc = result.details as Record<string, unknown>;
    expect(doc.title).toBe("New Title");
    expect(doc.content).toBeUndefined();
  });
});
