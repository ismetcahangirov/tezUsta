# The API's production image (#406): the built NestJS server, its production
# dependencies and nothing else. Built from the repository root, like the
# admin panel's image (ADR-0052):
#
#   docker build -f apps/api/Dockerfile -t tezusta-api .
#
#   # once per release, before the new servers start — never on boot:
#   docker run --rm --env-file api.env tezusta-api node dist/infra/database/migrate.js
#
#   docker run -p 3000:3000 --env-file api.env tezusta-api
#
# Every setting comes from the runtime environment and is validated by
# `env.schema.ts`, which refuses to boot without the required ones. Nothing is
# read at build time, so one image serves staging and production.
#
# Pinned exactly (CLAUDE.md §10): the Node the repository's `engines` and CI
# use. Alpine, because `sharp@0.35.5` ships a prebuilt `linuxmusl-x64` binary
# (`@img/sharp-linuxmusl-x64`) and the image is a fraction of a Debian one.

FROM node:24.19.0-alpine AS manifests
WORKDIR /repo
RUN corepack enable
# Every workspace manifest, so the frozen lockfile is checked as a whole; each
# stage below then installs only the API's own dependency tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY tools/project-graph/package.json tools/project-graph/

FROM manifests AS build
# Install scripts stay off, as in the panel's image. `@swc/core` and `esbuild`
# are test and dev tooling; `nest build` compiles with `tsc` and needs neither.
RUN pnpm install --frozen-lockfile --filter "api..." --ignore-scripts
COPY packages/types packages/types
COPY packages/typescript-config packages/typescript-config
COPY apps/api apps/api
RUN pnpm --filter api build \
  # Declarations and source maps stay out of the image: nothing in production
  # reads them, and a stack trace is never sent to a client anyway.
  && find apps/api/dist \( -name '*.map' -o -name '*.d.ts' \) -delete

FROM build AS deps
# Production dependencies only, as an isolated tree. A filtered `pnpm install`
# is not enough here: the workspace uses `nodeLinker: hoisted` for Expo, and a
# hoisted install lays out every workspace's dependencies — the mobile app's
# included. `pnpm deploy` resolves the API's own production closure from the
# same frozen lockfile into a fresh directory. `--legacy` because the
# workspace does not set `injectWorkspacePackages` (pnpm 10+ asks for one or
# the other). `sharp`'s native binary arrives as an optional dependency for
# this platform, so no install script is needed for it.
RUN pnpm --filter api deploy --prod --legacy --ignore-scripts /deploy \
  # `@tezusta/types` is a workspace package of TypeScript source. The compiled
  # API only mentions it in comments: every import of it is a type, erased by
  # `tsc`.
  && rm -rf /deploy/node_modules/@tezusta

FROM node:24.19.0-alpine
# The image's default is production, and that is a safety property: an
# operator who forgets NODE_ENV gets a server that refuses the stub providers
# at boot, never one that quietly runs them. Staging and CI set it explicitly.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=root:root /deploy/node_modules ./node_modules
COPY --from=build --chown=root:root /repo/apps/api/dist ./dist
COPY --chown=root:root apps/api/package.json ./package.json
# The files are root's and read-only to the process; it runs as `node`.
USER node
EXPOSE 3000
# `/health/live` is the liveness probe: the process answers, without asking
# Postgres or Redis. An orchestrator's readiness check should use
# `/health/ready`. BusyBox `wget` is in the base image; nothing is added.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT:-3000}/health/live" || exit 1
# Node is PID 1 and receives SIGTERM itself: `main.ts` enables Nest's shutdown
# hooks, which close the HTTP server, the sockets and the queue workers. The
# server spawns no child processes, so there is nothing for an init to reap.
CMD ["node", "dist/main.js"]
