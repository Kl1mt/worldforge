# syntax=docker/dockerfile:1
# Production images for Worldforge (ticket D.1, docs/DEPLOY.md). Build context: the repo root.
#   docker build -f deploy/Dockerfile --target server -t worldforge-server .
#   docker build -f deploy/Dockerfile --target web    -t worldforge-web .
# deploy/docker-compose.yml builds both.

ARG NODE_IMAGE=node:22-trixie-slim
ARG CADDY_IMAGE=caddy:2-alpine

# ---- build: install the workspace, build game-core, server and web --------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Manifests first, so the dependency layer is reused until the lockfile or a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/game-core/package.json packages/game-core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/game-core packages/game-core
COPY apps/server apps/server
COPY apps/web apps/web
# Topological: game-core → server, web. The server build excludes src/e2e and src/playtest.
RUN pnpm build
# A self-contained node_modules with production dependencies only (game-core copied from dist).
RUN pnpm --filter @worldforge/server deploy --prod --legacy /out/server

# ---- server: Node runtime, prod deps only, non-root ------------------------------------------
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
# Files stay owned by root and read-only for the `node` user that runs the process.
COPY --from=build /out/server/node_modules ./node_modules
COPY --from=build /repo/apps/server/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
# The e2e and playtest servers must never ship (they also refuse NODE_ENV=production).
RUN test ! -e dist/e2e && test ! -e dist/playtest && test -f dist/index.js \
  && test -f dist/db/migrate-cli.js && test -f dist/social/role-cli.js
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ---- web: Caddy serving the built client and proxying /api -----------------------------------
FROM ${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
RUN DOMAIN=localhost ACME_EMAIL=ops@example.com caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
