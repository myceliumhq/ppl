import { describe, expect, it } from "vitest";
import manifest from "../../openclaw.plugin.json" with { type: "json" };
import { filterReadOnlyTools, READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from "./read-only.js";

// The filter only ever looks at `.name`, so a stub with a name is a faithful
// stand-in for a real AnyAgentTool here -- no TypeBox schema, no client, no
// server needed to exercise the behavior that matters.
const stub = (name: string) => ({ name });

describe("filterReadOnlyTools", () => {
  it("returns the full list unchanged when read-only mode is off", () => {
    const tools = [
      stub("paperless_search_documents"),
      stub("paperless_update_document"),
      stub("paperless_create_taxonomy_term"),
    ];
    expect(filterReadOnlyTools(tools, false)).toEqual(tools);
  });

  it("keeps only read-only tools when read-only mode is on", () => {
    const tools = [
      stub("paperless_search_documents"),
      stub("paperless_update_document"),
      stub("paperless_read_document"),
      stub("paperless_create_taxonomy_term"),
    ];
    expect(filterReadOnlyTools(tools, true).map((tool) => tool.name)).toEqual([
      "paperless_search_documents",
      "paperless_read_document",
    ]);
  });

  it("drops every write tool the app ships, not just the ones a test remembered", () => {
    const tools = [...WRITE_TOOL_NAMES].map(stub);
    expect(filterReadOnlyTools(tools, true)).toEqual([]);
  });

  it("keeps every read-only tool the app ships", () => {
    const tools = [...READ_ONLY_TOOL_NAMES].map(stub);
    expect(filterReadOnlyTools(tools, true)).toEqual(tools);
  });

  it("drops an unrecognized tool in read-only mode -- unknown means untrusted, not allowed", () => {
    // A tool added later but never classified must not slip through as
    // readable by default. Failing closed here is what makes the drift test
    // below a correctness check rather than a security one.
    expect(filterReadOnlyTools([stub("paperless_some_future_tool")], true)).toEqual([]);
  });

  it("honors an explicitly supplied name set instead of the app-wide one", () => {
    const tools = [stub("a"), stub("b")];
    expect(filterReadOnlyTools(tools, true, new Set(["b"]))).toEqual([stub("b")]);
  });
});

describe("read-only tool classification", () => {
  // openclaw.plugin.json's contracts.tools is the app's full tool list, and
  // manifest.test.ts already pins it to what src/index.ts registers. The
  // standalone server (src/mcp-server.ts) builds the same set from the same
  // factories, so the manifest is usable here as the universe of tool names
  // without importing mcp-server.ts -- which can't be imported from a test
  // anyway, since it runs main() on load.
  const allToolNames: string[] = manifest.contracts.tools;

  it("classifies every registered tool as either read-only or write", () => {
    const unclassified = allToolNames.filter(
      (name) => !READ_ONLY_TOOL_NAMES.has(name) && !WRITE_TOOL_NAMES.has(name),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies no tool as both read-only and write", () => {
    const both = [...READ_ONLY_TOOL_NAMES].filter((name) => WRITE_TOOL_NAMES.has(name));
    expect(both).toEqual([]);
  });

  it("classifies no name that isn't a registered tool", () => {
    const registered = new Set(allToolNames);
    const classified = [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES];
    const stale = classified.filter((name) => !registered.has(name));
    expect(stale).toEqual([]);
  });
});
