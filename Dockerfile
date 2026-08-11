# Standalone MCP server image for ppl (src/mcp-server.ts) -- see AGENTS.md
# and README's "Standalone MCP server" section.
#
#   docker build -t ppl-mcp .
#
# Run (stdio, the default transport):
#
#   docker run -i --rm \
#     -e PAPERLESS_URL=https://paperless.example.com \
#     -e PAPERLESS_TOKEN=your-api-token \
#     ppl-mcp
#
# Or Streamable HTTP (loopback-only by default; expose on all interfaces via
# MCP_HOST=0.0.0.0, e.g. behind a reverse proxy on a bridged network). The
# app has NO built-in auth -- only expose non-loopback behind an authenticated
# proxy (Caddy Basic auth), list the proxy's public hostname in
# MCP_ALLOWED_HOSTS (DNS-rebinding protection), and prefer PAPERLESS_READ_ONLY:
#
#   docker run --rm -p 3000:3000 -e MCP_TRANSPORT=http \
#     -e MCP_HOST=0.0.0.0 -e MCP_ALLOWED_HOSTS=mcp.example.com \
#     -e PAPERLESS_URL=... -e PAPERLESS_TOKEN=... \
#     ppl-mcp
#
# To keep secrets out of plaintext env, PAPERLESS_URL_FILE /
# PAPERLESS_TOKEN_FILE take a path to a (Docker-secret) file whose trimmed
# contents are used instead -- e.g. -e PAPERLESS_TOKEN_FILE=/run/secrets/token

FROM node:22-slim AS build
RUN corepack enable
# Without this, pnpm treats node_modules as stale after the later `COPY . .`
# resets file mtimes (even though content is unchanged) and blocks on an
# interactive re-install confirmation that has no TTY to answer it.
ENV CI=true
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm run build
RUN pnpm install --frozen-lockfile --prod

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
EXPOSE 3000
USER node
ENTRYPOINT ["node", "dist/mcp-server.js"]
