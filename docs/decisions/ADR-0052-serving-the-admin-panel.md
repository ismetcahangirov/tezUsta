# ADR-0052 — The admin panel is served by nginx in front of the API

- **Status:** Accepted
- **Date:** 13 October 2026
- **Decided by:** Issue #331 (the owner's specification, which
  recommends the reverse proxy). The edge allow-list in § 6 is left to the
  owner.
- **Context:** issue #331; EPIC 20 (#327), EPIC 17 (#18)
- **Builds on:** [ADR-0043](ADR-0043-admin-panel-policy.md) § 4 and § 8 (one
  origin, httpOnly cookies, no CORS)

## Context

ADR-0043 puts the admin panel on the API's own origin, so that its httpOnly
cookies need no CORS with credentials. In development, Vite serves the panel
and proxies `/api/*` to the API with the prefix stripped. In production
nothing served `apps/admin/dist`, and every cookie assumption depended on how
that would be done. The hosting provider is still open (EPIC 17). This ADR
settles **how** the panel is served, whatever the host.

## Decision

### 1. A reverse proxy, not the API

nginx serves the built panel and forwards `/api/*` to the API. The image is
`apps/admin/Dockerfile`: a Node build stage, then
`nginxinc/nginx-unprivileged:1.30.5-alpine`, the current stable release,
running as a non-root user on port 8080.

Rejected: the API serving the files itself with `@fastify/static`. That puts
static traffic on the Node event loop that dispatch and the sockets run on. It
also adds a dependency and couples a panel release to an API release. The
proxy is one more process, but one that does nothing else.

### 2. The same layout as development

| Path             | Served by                                      |
| ---------------- | ---------------------------------------------- |
| `/api/*`, `/api` | the API, prefix stripped                       |
| `/assets/*`      | the panel's hashed files; a missing one is 404 |
| everything else  | the file if it exists, otherwise `index.html`  |

The panel's API base is `/api` in both environments, so it is one build. An
unknown path under `/api` gets the API's JSON 404, never the panel. A deep link
reloads into the panel.

The API's routes stay at its root; only the proxy adds the prefix. A mobile
client that goes through this proxy uses `<origin>/api` as its base.

### 3. Headers and caching on panel responses

- **CSP:** `default-src 'self'` and `'self'` for every fetch directive, plus
  `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and
  `frame-ancestors 'none'`. No inline script or style is allowed. No Google
  Fonts origin is listed: the Anybody faces are bundled, and the panel loads no
  third-party resource at all.
- **The rest:** `X-Robots-Tag: noindex, nofollow`, and the same set the API
  sends (#275): `nosniff`, `X-Frame-Options: DENY`, `no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`, and HSTS. Browsers ignore HSTS
  over plain HTTP.
- **Caching:** hashed assets get `public, max-age=31536000, immutable`.
  `index.html` and the few unhashed files get `no-cache`.
- **Source maps** are deleted from the image.

### 4. The cookies are unchanged

The admin cookies stay `HttpOnly`, `Secure` (everywhere but development),
`SameSite=Strict` and `Path=/`. `Path=/` covers `/api/*` under this layout, and
the smoke test asserts every attribute as the browser receives it through the
proxy.

### 5. The API trusts exactly the proxy

Behind a proxy, every request reaches the API from the proxy's address. The
per-IP rate limits would then see one client. `TRUST_PROXY` names the proxy's
own addresses (IPs or CIDRs). Fastify then takes the right-most
`X-Forwarded-For` entry that is not the proxy. nginx appends to that header and
never replaces it, so a client cannot forge the result. `true`, `*` and any
other value that is not an address are refused, as `trustProxy: true` already
was (#275). The default is empty, which trusts nobody.

### 6. Options left to the owner

A panel on a public URL is a target. An IP allow-list, or an access proxy at
the edge (for example a zero-trust tunnel), would shrink it to known networks.
That is an operational and commercial choice that belongs with the hosting
decision. It is recorded here and **not built**.

## Consequences

- CI builds the image on every pull request and runs a smoke test through it
  against the API built from the same commit. The test covers headers,
  caching, the fallback, the JSON 404, and a whole admin session with its
  cookies. The image is the panel's deployable artefact. Pushing it to a
  registry waits for EPIC 17.
- `docker compose --profile prodlike` runs the same image locally against an
  API on the host (`docs/engineering/admin-bootstrap.md`).
- The panel reads no build-time variable. A test fails if one appears, so no
  secret can be inlined into the public bundle.
- The deployment must set `TRUST_PROXY` to the proxy's address. If it does
  not, every client shares one rate-limit budget.

- `proxy_pass` names the upstream once, and nginx resolves it **at start**.
  An address, or a name whose address does not change (a Kubernetes service),
  is right. A container name that is recreated with a new address needs a
  `resolver` and a variable upstream instead.
- nginx's own error pages under `/api` (502, 504, a body above 2 MiB) carry no
  security headers. They are static HTML with nothing to execute. Adding the
  panel's set there would duplicate the API's headers on every API response.

## Revisit when

- The host is chosen and terminates TLS or caches at an edge. Its address may
  then belong in `TRUST_PROXY`, and HSTS may move there. `X-Forwarded-Proto`
  is set from nginx's own scheme, so behind a TLS load balancer it reads
  `http`. Nothing in the API reads it today; if something starts to, pass the
  outer value through.
- The panel ever needs a third-party origin, which means a CSP change in
  `apps/admin/deploy/nginx/panel-headers.conf` and a review.
