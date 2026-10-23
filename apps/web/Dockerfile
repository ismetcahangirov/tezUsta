# The master's web subscription page's production image (ADR-0061 § 1): the
# built page served by nginx, which also forwards `/api/*` to the API — one
# origin, the admin panel's arrangement (ADR-0052) on an origin of its own.
# Built from the repository root:
#
#   docker build -f apps/web/Dockerfile -t tezusta-web .
#   docker run -p 8081:8080 -e API_UPSTREAM=http://api:3000 tezusta-web
#
# The same pinned images as apps/admin/Dockerfile, for the same reasons.

FROM node:24.19.0-alpine AS build
WORKDIR /repo
RUN corepack enable

# Every workspace manifest, so the frozen lockfile can be checked as a whole,
# then only the page's own dependency tree is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY apps/web/package.json apps/web/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY tools/project-graph/package.json tools/project-graph/
RUN pnpm install --frozen-lockfile --filter "web..." --ignore-scripts

COPY packages/types packages/types
COPY packages/typescript-config packages/typescript-config
COPY apps/web apps/web
RUN pnpm --filter web build \
  && find apps/web/dist -name '*.map' -delete

FROM nginxinc/nginx-unprivileged:1.30.5-alpine
COPY apps/web/deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/deploy/nginx/page-headers.conf /etc/nginx/tezusta/page-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
