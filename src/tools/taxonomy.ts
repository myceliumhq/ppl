import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient, PaperlessClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { clampPageSize, paginationParams } from "./pagination.js";
import { fetchNameMap } from "./relations.js";

type TaxonomyKind = "tag" | "correspondent" | "document_type";
type TaxonomyEndpoint = "/api/tags/" | "/api/correspondents/" | "/api/document_types/";

const TAXONOMY_ENDPOINTS: Record<TaxonomyKind, TaxonomyEndpoint> = {
  tag: "/api/tags/",
  correspondent: "/api/correspondents/",
  document_type: "/api/document_types/",
};

// Tags, correspondents, and document types are structurally near-identical
// resources (id + name; tags also have a parent/children hierarchy) --
// consolidated into one list tool and one create tool parameterized by
// `kind`, rather than three near-duplicate tools per operation. Matches
// this plugin's document-content tools, which are split by *access
// pattern* (read/search/range), not by *resource kind*.
const taxonomyKindParam = Type.Union(
  [Type.Literal("tag"), Type.Literal("correspondent"), Type.Literal("document_type")],
  { description: "Which taxonomy resource to operate on." },
);

// owner/permissions are ACL metadata: not settable via any tool in this
// plugin and not relevant to taxonomy lookups -- stripped for the same
// reason as on documents (see shapeDocument in documents.ts).
function stripAcl<T extends Record<string, unknown>>(item: T): Omit<T, "owner" | "permissions"> {
  const { owner: _owner, permissions: _permissions, ...rest } = item;
  return rest;
}

// Tags can be hierarchical (parent/children), carried as bare ids just like
// documents' correspondent/document_type/tags. Resolved the same way: batch
// id__in lookups against /api/tags/ itself. Correspondents and document
// types are flat -- this only applies to `kind: "tag"`.
function collectTagHierarchyIds(tags: Record<string, unknown>[]): number[] {
  const ids = new Set<number>();
  for (const tag of tags) {
    if (typeof tag.parent === "number") ids.add(tag.parent);
    if (Array.isArray(tag.children)) {
      for (const childId of tag.children) {
        if (typeof childId === "number") ids.add(childId);
      }
    }
  }
  return [...ids];
}

function shapeTag<T extends Record<string, unknown>>(
  tagNames: Map<number, string>,
  tag: T,
): Record<string, unknown> {
  const { parent, children } = tag;
  return {
    ...stripAcl(tag),
    ...(typeof parent === "number" && tagNames.has(parent)
      ? { parent_name: tagNames.get(parent) }
      : {}),
    ...(Array.isArray(children)
      ? {
          children_names: children
            .filter(
              (childId): childId is number => typeof childId === "number" && tagNames.has(childId),
            )
            .map((childId) => tagNames.get(childId)),
        }
      : {}),
  };
}

async function shapeTagList<T extends { results?: unknown[] }>(
  client: PaperlessClient,
  response: T,
): Promise<T> {
  const tags = Array.isArray(response.results)
    ? (response.results as Record<string, unknown>[])
    : [];
  const tagNames = await fetchNameMap(client, "/api/tags/", collectTagHierarchyIds(tags));
  return {
    ...response,
    results: tags.map((tag) => shapeTag(tagNames, tag)),
  };
}

async function shapeSingleTag(
  client: PaperlessClient,
  tag: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tagNames = await fetchNameMap(client, "/api/tags/", collectTagHierarchyIds([tag]));
  return shapeTag(tagNames, tag);
}

const listTaxonomyParams = Type.Object({
  kind: taxonomyKindParam,
  name_contains: Type.Optional(
    Type.String({ description: "Case-insensitive name substring filter." }),
  ),
  ...paginationParams,
});

export function createListTaxonomyTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_list_taxonomy",
    label: "List paperless-ngx tags/correspondents/document types",
    description:
      "List existing tags, correspondents, or document types -- pick one via `kind` -- optionally " +
      "filtered by name. Tags are hierarchical: parent/children tag ids are automatically resolved " +
      "to parent_name/children_names alongside the ids. Correspondents and document types are flat.",
    parameters: listTaxonomyParams,
    execute: async (_toolCallId, params: Static<typeof listTaxonomyParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.GET(TAXONOMY_ENDPOINTS[params.kind], {
          params: {
            query: {
              name__icontains: params.name_contains,
              page: params.page,
              page_size: clampPageSize(params.page_size),
            },
          },
        }),
      );
      if (params.kind === "tag") {
        return toToolResult(await shapeTagList(client, result));
      }
      return toToolResult({
        ...result,
        results: Array.isArray(result.results) ? result.results.map(stripAcl) : result.results,
      });
    },
  };
}

const createTaxonomyTermParams = Type.Object({
  kind: taxonomyKindParam,
  name: Type.String({ description: "Name of the new entry." }),
  parent_id: Type.Optional(
    Type.Integer({
      description:
        'Parent tag id, for a hierarchical tag. Only meaningful when `kind: "tag"` -- ignored otherwise.',
    }),
  ),
});

export function createCreateTaxonomyTermTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_create_taxonomy_term",
    label: "Create a paperless-ngx tag, correspondent, or document type",
    description:
      "Create a new tag, correspondent, or document type -- pick one via `kind`. Check " +
      "paperless_list_taxonomy first to avoid creating a near-duplicate of an existing one.",
    parameters: createTaxonomyTermParams,
    execute: async (_toolCallId, params: Static<typeof createTaxonomyTermParams>) => {
      const { client } = await handlePromise;

      if (params.kind === "tag") {
        const result = unwrap(
          await client.POST("/api/tags/", {
            body: { name: params.name, parent: params.parent_id ?? null },
          }),
        );
        return toToolResult(await shapeSingleTag(client, result));
      }

      const endpoint =
        params.kind === "correspondent" ? "/api/correspondents/" : "/api/document_types/";
      const result = unwrap(await client.POST(endpoint, { body: { name: params.name } }));
      return toToolResult(stripAcl(result));
    },
  };
}
