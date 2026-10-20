# ADR-0056 — The API ships as one container image; migrations run as a one-off job

- **Status:** **Accepted**
- **Date:** 2026-10-20
- **Context:** EPIC 17 (#18), issue [#406]
- **Builds on:** [ADR-0025](ADR-0025-deferred-work-on-bullmq.md) (the worker
  runs in the API process), [ADR-0052](ADR-0052-serving-the-admin-panel.md)
  (the panel's image and its conventions)
- **Does not decide:** the hosting provider, which is still open (CLAUDE.md
  § 1). Everything here holds for any host that runs an OCI image.

[#406]: https://github.com/ismetcahangirov/tezUsta/issues/406

## Context

The admin panel had a production image; the API did not. The `prodlike`
compose profile ran the API on the host, from its build, so there was no
artefact to deploy, scan or smoke-test. Whichever host EPIC 17 picks, it will
run a container, and the decisions below are the ones a deploy pipeline would
otherwise make implicitly, on the day it is first needed.

## Decision

### 1. One image, `apps/api/Dockerfile`, built from the repository root

Multi-stage:

- a manifests stage, so the frozen lockfile is checked as a whole;
- a build stage, `nest build`, with declarations and source maps removed;
- a deps stage that runs **`pnpm deploy --prod`**;
- a runtime stage holding `dist`, the production `node_modules` and
  `package.json`.

**`pnpm deploy`, not a filtered install.** The workspace is
`nodeLinker: hoisted` for Expo, and a hoisted install lays out every
workspace's dependencies whatever the filter says. Measured: the filtered
install left 863 MB of `node_modules` in the image, Expo, React and TypeScript
included. `pnpm deploy` resolves the API's own production closure from the
same lockfile: 126 MB, and an image of about 400 MB uncompressed.

### 2. `node:24.19.0-alpine`, pinned exactly

It is the Node the repository's `engines` and CI use. Alpine works because
`sharp@0.35.5` ships a prebuilt `linuxmusl-x64` binary as an optional
dependency, so it installs with scripts off and loads in the image (CI checks
it). A Debian base would cost several times the size for nothing the API
uses.

### 3. Migrations are a one-off job, never part of boot

`docker run <image> node dist/infra/database/migrate.js` applies pending
migrations and exits; running it again is a no-op. The server never migrates
on start, as `migrate.ts` has always insisted. With N replicas, a migration on
boot is N processes racing the same DDL. During a rolling deploy, the old
version and the new one are both live, so the migration must be a separate,
single step that runs before the new servers start. Compose models it as
`api-migrate`, with `api` waiting on `service_completed_successfully`; a host
will model it as a release job.

### 4. The image's `NODE_ENV` is `production`

Forgetting the variable must fail closed. Every stub provider refuses to
construct under `production`. So an image started without `NODE_ENV` refuses
to boot until real providers are configured. It never runs, quietly, as a
development server with invented SMS and maps. Staging, CI and the local
`prodlike` run set `NODE_ENV=test` explicitly. Today a real `production` boot
is impossible by design: no SMS provider is chosen (#389).

### 5. Node is PID 1; non-root; read-only application files

- **PID 1.** `main.ts` enables Nest's shutdown hooks, so SIGTERM closes the
  HTTP server, the sockets and the queue workers. Measured: `docker stop` ends
  in about 2 s with exit code 0. The server spawns no child processes, so there
  is nothing for an init such as `tini` to reap, and adding one would be a
  package with no job.
- **Non-root.** The process runs as `node`. The files are root's, so it cannot
  rewrite its own code.
- **Health.** A `HEALTHCHECK` probes `/health/live`, which does not ask Postgres
  or Redis. An orchestrator's readiness check should use `/health/ready`.

### 6. The worker split stays an environment change

ADR-0025 runs the queue workers in the API process. Extracting them later is
`QUEUE_WORKER_MODE=off` and `MEDIA_WORKER_MODE=off` on the API replicas, plus
the same image started with the workers on and no traffic routed to it. It is
not a second image.

## Consequences

- CI's **API image smoke** job builds the image and checks it in this order:
  1. it runs as a non-root user, holds no dev tooling, and loads `sharp`;
  2. it migrates twice, the second run finding nothing to do;
  3. it serves `/health/ready` (200) and a guarded route (401, not 500);
  4. its `HEALTHCHECK` reaches healthy;
  5. it stops on SIGTERM with exit code 0.
- The `prodlike` compose profile runs `api-migrate`, `api` and `admin-proxy`
  from the images. The proxy sits at a fixed address on an `edge` network,
  which the API trusts as `TRUST_PROXY`.
- `docs/engineering/admin-bootstrap.md` § 6 runs the production-like smoke
  from the images.

## Alternatives considered

| Option                                              | Why not                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Filtered `pnpm install --prod` in the runtime stage | Hoisted linker installs the whole workspace: 863 MB with Expo and React                            |
| `node:24-bookworm-slim`                             | Several times the size; nothing in the API needs glibc, since `sharp` has a musl binary            |
| Migrate in the container's entrypoint before boot   | Replicas race the DDL; a rolling deploy runs it from a version about to be replaced                |
| No `NODE_ENV` in the image (schema default)         | The schema defaults to `development`, which admits the stubs: a forgotten variable would fail open |
| `tini` as PID 1                                     | No child processes to reap; Node already handles SIGTERM through Nest's hooks                      |
| A separate worker image                             | ADR-0025's in-process worker; splitting is an environment change on the same image                 |

## Revisit when

- EPIC 17 picks a host whose platform supplies its own init or health model, or
  that needs a different architecture (arm64 images need a multi-platform
  build).
- The API gains a child process, a native dependency without a musl build, or
  a second entry point that should not share this image.
- Migrations become long enough to need an expand/contract tool rather than
  a single job.
