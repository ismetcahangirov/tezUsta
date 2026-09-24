# Applications

| App      | What it is                                                 | State                                                      |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `mobile` | Expo app — customer and master in one role-switched binary | **Exists.**                                                |
| `api`    | NestJS on Fastify — REST + WebSocket                       | **Exists.**                                                |
| `admin`  | Web admin panel — Vite + React SPA                         | **Exists.** Sign-in, invitation setup and the shell (#247) |

`mobile` runs with `pnpm --filter mobile dev`, `api` with
`pnpm --filter api dev`, and `admin` with `pnpm --filter admin dev`, which
serves the panel on port 5173 and proxies `/api/*` to the API — the panel and
the API share one origin ([ADR-0043](../docs/decisions/ADR-0043-admin-panel-policy.md) § 4).

The admin panel's authentication is a separate credential path from the mobile
app's ([ADR-0014](../docs/decisions/ADR-0014-admin-authentication.md)).

Boundaries between them are enforced, not conventional: no app may import
another, and the clients share only the contracts in `packages/types`. See
[`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs).
