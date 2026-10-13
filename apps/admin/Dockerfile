# The admin panel's production image (ADR-0052, #331): the built panel served
# by nginx, which also forwards `/api/*` to the API — one origin, as ADR-0043
# § 4 requires. Built from the repository root:
#
#   docker build -f apps/admin/Dockerfile -t tezusta-admin .
#   docker run -p 8080:8080 -e API_UPSTREAM=http://api:3000 tezusta-admin
#
# Both images pinned to exact versions (CLAUDE.md §10): nginx 1.30.5 is the
# current stable release (15 Sep 2026, CVE-2026-90439), and the build stage
# uses the Node the repository's `engines` asks for.

FROM node:24.19.0-alpine AS build
WORKDIR /repo
RUN corepack enable

# Every workspace manifest, so the frozen lockfile can be checked as a whole,
# then only the panel's own dependency tree is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY tools/project-graph/package.json tools/project-graph/
RUN pnpm install --frozen-lockfile --filter "admin..." --ignore-scripts

COPY packages/types packages/types
COPY packages/typescript-config packages/typescript-config
COPY apps/admin apps/admin
RUN pnpm --filter admin build \
  # Source maps stay out of the image: the panel's source is not secret, but
  # nothing needs it in production either.
  && find apps/admin/dist -name '*.map' -delete

FROM nginxinc/nginx-unprivileged:1.30.5-alpine
COPY apps/admin/deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/admin/deploy/nginx/panel-headers.conf /etc/nginx/tezusta/panel-headers.conf
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
