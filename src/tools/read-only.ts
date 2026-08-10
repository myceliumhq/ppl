// Read-only mode for the standalone MCP server (PAPERLESS_READ_ONLY=true).
//
// This module is deliberately dependency-free -- no `openclaw`, no client,
// no server -- so the tool partition below can be unit-tested without
// standing anything up. Everything here is name-based: AnyAgentTool.parameters
// is a TypeBox TSchema, but a name is a plain string, so nothing in this file
// needs to touch TypeBox at all.
//
// Only the standalone server consults this. The OpenClaw plugin path
// (src/index.ts + openclaw.plugin.json) registers the full tool set
// unconditionally: OpenClaw isn't the remote-exposure surface this guards,
// and its manifest contract is a fixed list that must keep matching what
// register() registers.

/**
 * Tools that only ever read from paperless-ngx. This is the exact set the
 * standalone server keeps when read-only mode is on.
 *
 * `paperless_list_taxonomy` belongs here despite sitting in taxonomy.ts next to
 * a write tool -- it lists tags/correspondents/document types, which is how the
 * read tools' filter arguments get resolved to ids in the first place. Dropping
 * it would leave read-only mode able to search but not to name what it's
 * filtering by.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "paperless_search_documents",
  "paperless_get_document",
  "paperless_read_document",
  "paperless_search_document_content",
  "paperless_list_taxonomy",
]);

/**
 * Tools that create or mutate paperless-ngx state -- everything read-only mode
 * drops.
 *
 * This isn't used by the filter (which keys off READ_ONLY_TOOL_NAMES alone);
 * it exists so a test can assert that every tool the app registers is
 * classified one way or the other. Without that assertion, a newly added tool
 * would silently land on the "dropped in read-only mode" side by default --
 * fail-safe for security, but silent, and silence is how a read tool goes
 * missing from a read-only deployment for a release or two.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "paperless_update_document",
  "paperless_create_taxonomy_term",
]);

/**
 * Trim a tool list down to the read-only tools when read-only mode is on.
 *
 * The trim is hard: filtered-out tools are never handed to createMcpServer, so
 * they don't appear in tools/list and there is no tools/call handler to reach.
 * That matters because the motivating deployment is MCP-over-HTTP, where the
 * server is reachable by anything that can hit the port -- a tool that is
 * merely flagged, annotated or "discouraged in the description" is still a live
 * mutation endpoint. Not registering it at all is the only version of this that
 * is actually a security property.
 *
 * @param tools every tool the server would otherwise register.
 * @param readOnly whether read-only mode is on; when false this is a no-op.
 * @param readOnlyNames names to keep, defaulting to this app's read-only set.
 *   Parameterized so tests can exercise the filter against a fixture set.
 */
export function filterReadOnlyTools<T extends { name: string }>(
  tools: readonly T[],
  readOnly: boolean,
  readOnlyNames: ReadonlySet<string> = READ_ONLY_TOOL_NAMES,
): T[] {
  if (!readOnly) return [...tools];
  return tools.filter((tool) => readOnlyNames.has(tool.name));
}
