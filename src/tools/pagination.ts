import { Type } from "typebox";

// paperless-ngx's list endpoints (documents, tags, correspondents, document
// types) will return as many results per page as asked. Without a cap, a
// broad list call can pull far more objects into a tool-calling model's
// context than it needs. Shared across every list tool so the cap can't
// silently apply to some endpoints and not others.
export const MAX_PAGE_SIZE = 100;

export function clampPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  return Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
}

export const paginationParams = {
  page: Type.Optional(Type.Integer({ description: "Page number, 1-indexed." })),
  page_size: Type.Optional(
    Type.Integer({
      description: `Results per page, capped at ${MAX_PAGE_SIZE} regardless of what's requested. Defaults to the server's page size if omitted.`,
    }),
  ),
};
