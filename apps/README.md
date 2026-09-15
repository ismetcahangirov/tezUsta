# Applications

| App      | What it is                                                 | State                                                        |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `mobile` | Expo app — customer and master in one role-switched binary | **Exists.** Scaffolded, with the design system and Storybook |
| `api`    | NestJS on Fastify — REST + WebSocket                       | Planned, EPIC 1                                              |
| `admin`  | Web admin panel                                            | Planned, EPIC 13                                             |

`mobile` runs today (`pnpm --filter mobile dev`), but no business feature is
implemented in it yet. `api` and `admin` do not exist on disk; do not write a
document or an import that assumes they do.

The two planned apps arrive in different Epics on purpose. `api` is foundation
work; `admin` waits until there is something to administer, and its
authentication is a separate credential path from the mobile app's
([ADR-0014](../docs/decisions/ADR-0014-admin-authentication.md)).

Boundaries between them are enforced, not conventional: `mobile` may not import
`api`, and `api` may not import either client. See
[`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs).
