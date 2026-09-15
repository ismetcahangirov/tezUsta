# CLAUDE.md — TezUsta engineering rulebook

> **This file is the highest-priority project-specific instruction for every
> Claude Code session in this repository.** Read it before touching anything.
> Where it is silent, follow the linked document. Where a linked document
> conflicts with this file, this file wins.

---

## 1. Project overview

**TezUsta** is an on-demand marketplace for urgent and small household repair
services (plumbing, locks, electrical, AC, appliances, assembly, painting,
cleaning). A **customer** describes a problem and TezUsta dispatches a nearby
verified **master** — the workflow philosophy of a ride-hailing app, applied to
home repair.

Primary market: **Azerbaijan** (initially Baku). Currency **AZN**.

| Document                                                               | What it covers                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| [`docs/product/product-overview.md`](docs/product/product-overview.md) | What TezUsta is, scope, non-goals              |
| [`docs/product/user-roles.md`](docs/product/user-roles.md)             | Customer, master, admin, and their permissions |
| [`docs/product/customer-flow.md`](docs/product/customer-flow.md)       | End-to-end customer journey                    |
| [`docs/product/master-flow.md`](docs/product/master-flow.md)           | End-to-end master journey                      |
| [`docs/product/admin-flow.md`](docs/product/admin-flow.md)             | Admin and moderation operations                |

**Current phase: foundation.** No business features are implemented yet. Work is
driven by GitHub Epics and Sub-Issues — see
[`docs/project-management/roadmap.md`](docs/project-management/roadmap.md).

### Product decisions already settled

These are **decided** — do not re-open them or design around alternatives:

| Decision            | Outcome                                                         | ADR                                                           |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Sign-in             | **Phone + SMS OTP only.** No social sign-in.                    | [ADR-0008](docs/decisions/ADR-0008-otp-delivery.md)           |
| Admin sign-in       | **Separate path**: email + password + mandatory TOTP            | [ADR-0014](docs/decisions/ADR-0014-admin-authentication.md)   |
| Dispatch            | **Parallel broadcast, first accept wins** (Bolt-style)          | [ADR-0009](docs/decisions/ADR-0009-dispatch-model.md)         |
| Who sets the price  | **The master**; platform takes a commission                     | [ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md) |
| When price is fixed | **At accept**, from the accepting master; null while searching  | [ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)     |
| Order lifecycle     | **14 statuses**; re-dispatch, no-master-found, dispute outcomes | [ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md) |
| Payment methods     | **Both cash and card**                                          | [ADR-0007](docs/decisions/ADR-0007-payments.md)               |
| Maps / geocoding    | **Google Maps Platform**                                        | [ADR-0004](docs/decisions/ADR-0004-location-and-maps.md)      |
| Design system       | **Light + dark, Anybody, lime accent, closed palette**          | [ADR-0011](docs/decisions/ADR-0011-design-system.md)          |
| Component workshop  | **Storybook on React Native Web + Vite**                        | [ADR-0012](docs/decisions/ADR-0012-component-workshop.md)     |
| Shared packages     | **Created on the second consumer**, not speculatively           | [ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)  |
| State management    | **Redux Toolkit** for client state, **RTK Query** for server    | [ADR-0017](docs/decisions/ADR-0017-state-management.md)       |

### Decisions still open

This is the whole list. If a document presents something else as open, that
document is stale; if it presents one of the decisions above as open, it is
wrong. Nothing here can be researched — each needs the owner, a lawyer, or a
commercial relationship.

| Open decision                                        | Blocks                                    |
| ---------------------------------------------------- | ----------------------------------------- |
| 🔴 **SMS provider + sender ID**                      | Completing EPIC 2 — real sign-in          |
| 🔴 **Object storage provider** (ADR-0005)            | Document upload (EPIC 5), photos (EPIC 6) |
| **Does TezUsta hold customer funds?** (needs legal)  | EPIC 12                                   |
| Payment provider                                     | EPIC 12                                   |
| Commission rate + price guardrails                   | EPIC 12                                   |
| Master verification criteria                         | EPIC 5                                    |
| Cancellation rules and penalties                     | EPIC 8                                    |
| Hosting / cloud provider                             | EPIC 17                                   |
| Account recovery when the phone number is lost       | Launch                                    |
| Languages at launch                                  | Launch                                    |
| In-app chat at launch                                | Open product question                     |
| Owner art: app icon, splash, map style, illustration | Polish, not features                      |

The SMS provider blocks **completing** EPIC 2, not starting it: EPIC 2 builds
the OTP sender behind a provider interface with a stub sender, which is how the
rest of authentication proceeds without it. Nobody can actually sign in until a
provider is chosen.

---

## 2. Architecture

TezUsta is a **pnpm + Turborepo monorepo**.

**`✓` exists on disk today. Everything else is planned** — do not assume a
planned path exists, and do not create one to satisfy a document.

```
apps/
✓ mobile/   Expo (React Native) — customer + master in one binary, role-switched
✓ api/      NestJS on Fastify — REST + WebSocket
  admin/    Web admin panel                               (planned, EPIC 13)
packages/
  types/              Shared domain types and API contracts        (planned)
  validation/         Zod schemas shared across the API boundary   (planned)
  api-client/         Typed client for apps/mobile and apps/admin  (planned)
  ui/                 Shared presentational components             (planned)
  config/             Shared runtime config + env parsing          (planned)
✓ typescript-config/  Shared tsconfig presets
✓ eslint-config/      Shared flat ESLint config
tools/
✓ project-graph/      Dependency graph + architecture rule enforcement
```

**Packages are created when a second consumer exists, not before**
([ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)). That applies to
all five planned packages, not only to `ui` and `api-client`. Until the second
consumer arrives, the code lives in its single consumer, behind the same
interface it would have had as a package:

| Concern                         | Lives in                                              | Moves to              |
| ------------------------------- | ----------------------------------------------------- | --------------------- |
| Geocoding, SMS, storage, config | `apps/api/src/infra/<domain>/`                        | `packages/config`     |
| Domain types and API contracts  | `apps/api/src/**/*.types.ts`                          | `packages/types`      |
| Zod schemas                     | `apps/api/src/**/*.schema.ts`                         | `packages/validation` |
| Design system and components    | `apps/mobile/src/theme`, `apps/mobile/src/components` | `packages/ui`         |

The interface is designed as if it were already a package — no vendor SDK type
crosses the boundary — so extraction is later a file move, not a redesign.

Read before making an architectural change:

| Document                                                                                   | What it covers                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md) | System shape, boundaries, invariants        |
| [`docs/architecture/technology-stack.md`](docs/architecture/technology-stack.md)           | **Every pinned version and why**            |
| [`docs/architecture/system-design.md`](docs/architecture/system-design.md)                 | Runtime topology, scaling model             |
| [`docs/architecture/frontend-architecture.md`](docs/architecture/frontend-architecture.md) | Expo app structure, state management        |
| [`docs/architecture/backend-architecture.md`](docs/architecture/backend-architecture.md)   | NestJS modules, error model, API design     |
| [`docs/architecture/database-architecture.md`](docs/architecture/database-architecture.md) | Schema approach, migrations, geo indexing   |
| [`docs/architecture/realtime-architecture.md`](docs/architecture/realtime-architecture.md) | WebSocket, presence, location update budget |
| [`docs/architecture/authentication.md`](docs/architecture/authentication.md)               | Token lifecycle, storage, authorization     |
| [`docs/architecture/location-services.md`](docs/architecture/location-services.md)         | Maps, geocoding, nearby-master queries      |

Architecture **decisions** live in [`docs/decisions/`](docs/decisions/) as ADRs.
Changing a decision means writing a new ADR that supersedes the old one — never
silently editing an accepted ADR.

---

## 3. Technology stack

Full reasoning, alternatives, and verification evidence:
[`docs/architecture/technology-stack.md`](docs/architecture/technology-stack.md).

The pins below are **not** "latest". They are the result of a compatibility
review. Three of them are deliberately _behind_ the newest published release:

| Pin                  | Newest published | Why we are behind                                                                                                                                                                                       |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript@6.0.3`   | `7.0.2`          | `typescript-eslint@8.70.0` declares `typescript >=4.8.4 <6.1.0`. TS 7 would disable all type-aware linting.                                                                                             |
| `expo@57.x`          | `58.0.0-preview` | SDK 58 is published only under the `preview` dist-tag. `latest` is 57.                                                                                                                                  |
| `tailwindcss@3.4.17` | `4.3.3`          | NativeWind v4 documents `tailwindcss@^3.4.17`. Its peer range `>3.3.0` _accepts_ Tailwind 4 but the pairing is unsupported. NativeWind v5 (Tailwind 4) is explicitly "not intended for production use". |

**Do not upgrade any of these without re-running the compatibility check and
writing an ADR.** The loose peer range on NativeWind in particular will let a
broken install succeed silently.

---

## 4. Folder and naming conventions

| Thing               | Convention                  | Example                |
| ------------------- | --------------------------- | ---------------------- |
| Directories         | `kebab-case`                | `order-lifecycle/`     |
| React components    | `PascalCase.tsx`            | `OrderCard.tsx`        |
| Hooks               | `useThing.ts`               | `useNearbyMasters.ts`  |
| NestJS files        | `name.role.ts`              | `orders.service.ts`    |
| Tests               | co-located, `.test.ts(x)`   | `OrderCard.test.tsx`   |
| Types               | `PascalCase`                | `OrderStatus`          |
| Constants           | `SCREAMING_SNAKE_CASE`      | `MAX_SEARCH_RADIUS_M`  |
| DB tables / columns | `snake_case`, tables plural | `order_status_history` |
| Env vars            | `SCREAMING_SNAKE_CASE`      | `JWT_ACCESS_SECRET`    |

Full standards: [`docs/engineering/coding-standards.md`](docs/engineering/coding-standards.md).

**`EXPO_PUBLIC_*` env vars are embedded in the shipped app bundle and readable
by any user. Never put a secret behind that prefix.**

A value is a **secret** if it grants server authority or billing power. The one
documented exception is a platform-restricted client map key — restricted by
bundle id or package name and scoped to the Maps SDK — which the client cannot
function without and which is protected by the restriction rather than by
secrecy. `GOOGLE_MAPS_SERVER_API_KEY` is billable and must never carry the
prefix. If you are adding a third exception, you are wrong.

---

## 5. Git rules

- **Never commit directly to `main`.** `main` is the integration branch.
- Branch names: lowercase kebab-case, `type/short-description`, with the issue
  number when one exists: `feat/123-order-creation`.
- Allowed types: `feat` `fix` `refactor` `test` `docs` `chore` `perf` `security`.
- Forbidden branch names: `test`, `dev`, `fix`, `branch1`, `new-feature`,
  `mybranch`, `patch-1`. A branch name is a message to whoever reads the history
  later; none of these say anything.
- One logical change per commit. No "misc fixes" commits.
- Never force-push a branch someone else may have pulled.
- Never commit `.env`, keys, tokens, credentials, or `google-services.json`.

**Commits use [Conventional Commits](https://www.conventionalcommits.org/):**

```
feat(order): add order creation endpoint with address validation
fix(matching): prevent double assignment under concurrent accept
perf(location): add GiST index for nearby-master radius query
security(auth): rate-limit OTP requests per phone number
```

Details: [`docs/engineering/git-workflow.md`](docs/engineering/git-workflow.md).

---

## 6. GitHub rules

**GitHub Issues are the source of truth for what gets built.** Every
implementation task corresponds to an Issue. Large features are Epics with
native Sub-Issues.

Every issue body uses the template in
[`docs/project-management/issue-rules.md`](docs/project-management/issue-rules.md):

```
## Objective
## Context
## Requirements
## Technical considerations
## Acceptance criteria
## Testing requirements
## Dependencies
## Definition of Done
```

- Every implementation issue is **assigned to `ismetcahangirov`** (repository owner).
- Every issue carries at minimum one `type:`, one `area:`, one `priority:`, and
  one `size:` label.
- Vague issues ("Implement authentication") are not acceptable. Name the
  behaviour and its boundary ("Implement customer phone authentication with
  refresh-token rotation and device session revocation").
- Close an issue only from a merged PR, and only after the Definition of Done is met.

Labels and full workflow: [`docs/engineering/github-workflow.md`](docs/engineering/github-workflow.md).

---

## 7. The workflow for every task

Run this before starting **any** implementation issue. Do not skip a step
without stating the technical reason in the PR.

```
 1. Read CLAUDE.md and the relevant docs/ + ADRs
 2. Read the GitHub Issue in full
 3. git fetch origin && git checkout main && git pull origin main
 4. Verify the working tree is clean
 5. Create the task branch
 6. Query the project graph for blast radius (node tools/project-graph/query.mjs <file>)
 7. Research official documentation for anything uncertain (section 9)
 8. Identify dependencies and possible regressions
 9. Write the failing test first where the change is testable
10. Implement
11. pnpm verify     (format + lint + typecheck + test + build + graph:validate)
12. pnpm graph:check (regenerate the graph and fail if the committed one moved)
13. git diff — review every hunk; confirm no unrelated changes
14. Commit (Conventional Commits)
15. Push the branch
16. Open the PR, linking "Closes #<issue>"
17. Update the GitHub Issue with what was done and what was verified
18. Report honestly — including anything not verified
```

---

## 8. Definition of Done

A task is **not** done because it compiles. It is done when **all** of these hold:

- [ ] Every requirement in the issue is implemented
- [ ] Tests written, covering behaviour (not implementation details)
- [ ] `pnpm test` passes — **executed, not assumed**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm build` passes where the workspace has a build
- [ ] `pnpm graph:validate` passes (no architecture rule violations)
- [ ] `pnpm graph:check` passes — the committed graph matches the source tree
- [ ] Security implications considered (section 11)
- [ ] Performance implications considered (section 12)
- [ ] Documentation / ADR updated where a decision was made
- [ ] `git diff` reviewed; no unrelated changes
- [ ] GitHub Issue updated
- [ ] Branch pushed and PR opened

---

## 9. Research requirements

**Do not act on assumption when a technical decision matters.**

Before choosing a library, version, API, or pattern:

1. Inspect what the repository already does.
2. Read the **official** documentation, repository, RFC, or spec.
3. Verify version compatibility against actual registry and peer metadata —
   not against memory. `curl https://registry.npmjs.org/<pkg>/<version>` is a
   primary source; a blog post is not.
4. Compare realistic alternatives.
5. Record the reasoning (an ADR for architectural decisions).

Prefer, in order: official docs → official repo → official spec → established
technical reference. Do **not** rely on old StackOverflow answers, random blogs,
outdated tutorials, or recollection.

**A published doc summary can be wrong.** During this repository's own setup the
Drizzle documentation page implied there was no native PostGIS support;
inspecting the shipped package proved otherwise. When a document and the
artifact disagree, **the artifact wins** — verify against the installed package.

When several approaches are valid, present:

```
Decision / Why / Alternatives considered / Trade-offs / Recommendation
```

---

## 10. Dependency policy

Before adding any package, answer:

- Is it actually necessary, or is this a few lines of our own code?
- Is it actively maintained (recent releases, issues triaged)?
- Does it support our pinned Node / Expo / React Native / TypeScript versions —
  checked against its real `peerDependencies` and `engines`?
- Does it introduce a security or licensing concern?
- Does something already in the tree solve this?
- Is the bundle / runtime cost justified on a mid-range Android device?

Prefer fewer dependencies. Pin exact versions for tooling. Record notable
additions in [`docs/engineering/dependency-policy.md`](docs/engineering/dependency-policy.md).

---

## 11. Security requirements

Security is a first-class requirement, not a later Epic.

- **Validate every input at the API boundary with Zod.** Never trust the client.
- **Never rely on a frontend role check.** Authorization is enforced server-side,
  per request, every time.
- Parameterised queries only — Drizzle's query builder, never string-built SQL.
- Rate-limit authentication, OTP, order creation, and review submission.
- Tokens on mobile go in **`expo-secure-store`**, never `AsyncStorage`.
- Uploads: presigned URLs, a content-type allow-list, a size cap, and
  server-side validation of the actual bytes — not the declared MIME type.
- Never log tokens, OTP codes, full phone numbers, or precise coordinates.
- Location is PII. A master's live position is visible only to the customer on
  the active order, and only while that order is active.
- Errors returned to clients carry a stable code and a safe message. Stack
  traces, SQL, and infrastructure details never leave the server.

Full list and threat notes: [`docs/engineering/security.md`](docs/engineering/security.md).

---

## 12. Performance requirements

- No N+1 queries. No unindexed query on a hot path.
- Every geo query uses the PostGIS GiST index — never a full-table distance scan.
- Location updates are **budgeted**, not continuous — see
  [`docs/architecture/realtime-architecture.md`](docs/architecture/realtime-architecture.md).
- No uncontrolled polling; server state goes through RTK Query.
- Backend handlers stay non-blocking; heavy work goes to a BullMQ queue.
- The API must be horizontally scalable — no in-process state that two
  instances would disagree about.
- The app must stay responsive on a mid-range Android device, which is the
  realistic device for both customers and masters in this market.

Details: [`docs/engineering/performance.md`](docs/engineering/performance.md).

---

## 13. Testing requirements

Tests verify **behaviour**, not implementation.

```
Bad:   expect(component.state.isOpen).toBe(true)
Good:  user taps "Accept" → the order shows "On the way"
```

- Every reusable component has a co-located test.
- Every state-machine transition has a test, **including the invalid ones**.
- Every API endpoint has an integration test covering auth, validation failure,
  and the happy path.
- No blanket snapshot tests. A snapshot nobody reads is not a test.

Strategy and tooling: [`docs/engineering/testing-strategy.md`](docs/engineering/testing-strategy.md).

---

## 14. Project graph

The repository maintains a machine-readable dependency graph so an agent can
answer _"what breaks if I change this?"_ without reading the whole codebase.

```bash
pnpm graph                                        # regenerate
pnpm graph:check                                  # regenerate and fail if it moved
pnpm graph:validate                               # CI gate on architecture rules
node tools/project-graph/query.mjs <file>         # blast radius + covering tests
node tools/project-graph/query.mjs --untested apps/api
```

**Query the graph before editing shared code.** Regenerate it after a feature, a
refactor, a new module, a dependency change, or an architecture change. The
output carries no timestamp and is a pure function of the source tree, which is
what lets CI detect a stale committed graph.

Boundaries enforced as CI-failing rules in [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs):

- no circular dependencies
- production code may not import a devDependency
- no undeclared dependency — a phantom import that `nodeLinker: hoisted` would
  otherwise resolve happily and a clean install would not
- no deprecated Node core module
- `apps/mobile` may not import `apps/api`
- `apps/api` may not import `apps/mobile` or `apps/admin`
- `packages/*` may not import `apps/*`

**A rule only counts if it can fail.** Adding `includeOnly`, or an `exclude`
pattern not anchored to `^(apps|packages|tools)/`, removes npm edges from the
graph before the rule engine sees them and silently disables the three npm
rules — `not-to-dev-dep`, `no-non-package-json` and `no-deprecated-core`.
(`no-circular` reasons about source-to-source edges and is unaffected.)
After changing dependency-cruiser `options`, prove the rules still fire: import
a devDependency and an undeclared package from a source file, confirm
`pnpm graph:validate` fails, then revert.

Details: [`tools/project-graph/README.md`](tools/project-graph/README.md).

---

## 15. Memory system

`claude-mem` is enabled at the user level and preserves context across sessions.

**Memory does not replace documentation.** A decision that matters lives in the
repository — CLAUDE.md, `docs/`, an ADR, or a GitHub Issue. Memory is a
convenience layer over that, never the only record.

Never put secrets, tokens, or credentials into memory.

---

## 16. Documentation rules

- A decision that changes architecture gets an **ADR** in `docs/decisions/`.
- ADRs are immutable once accepted. Supersede, do not rewrite.
- Update the relevant `docs/` page in the same PR as the change it describes.
- `docs/` explains **why**; code comments explain **why this way**; neither
  restates what the code plainly says.
- Generated files (`tools/project-graph/output/`) are never hand-edited.

---

## 17. Design decisions — ask, do not invent

**The user owns the visual design system. You do not.**

Do not independently decide: brand colours, typography, spacing scale, icon
style, card or button design, navigation pattern, map UI, onboarding flow,
empty states, or any other visual language.

When a task needs a design decision that has not been given: **stop and ask.**

> "Implementing the order tracking screen requires deciding how the master's
> live position and ETA are presented. Please provide the intended design."

Technical architecture may be decided through research (section 9). Visual and
product decisions may not. Build the component architecture so the visual layer
stays configurable, and leave the visual choice to the user.

**The design system has now been supplied**:
[`docs/design/design-system.md`](docs/design/design-system.md)
([ADR-0011](docs/decisions/ADR-0011-design-system.md)). Work inside it rather
than asking again — but everything it does not cover is still the user's call,
and a value that is not a token is not a value you may invent. Review components
in Storybook (`pnpm --filter mobile storybook`) before wiring them into a screen.

Still outstanding and owner-owned — the design system does **not** cover these,
so the "stop and ask" rule above still applies in full:

- app icon and splash artwork
- the Google Maps style JSON
- illustration and empty-state art
- motion and transitions
- the **navigation pattern** — tab bar versus stack, and what lives at the root
- the **onboarding flow** — what a first-run user is shown, and in what order
- the **content** of an empty state, as opposed to the components it is built
  from

The design system settles colour, type, spacing, radius, elevation and the
component inventory. It does not settle how screens are arranged or what a
first-time user meets, and neither does this file.

---

## 18. Asking the user questions

- Ask only what actually blocks the current work.
- Ask few questions at a time, not twenty.
- Do the parts that are not blocked first, then ask.
- For a technical trade-off, present: **Decision / Why / Alternatives / Trade-offs / Recommendation.**
- State a recommendation. Do not present a neutral menu and wait.

---

## 19. Never destroy existing work

Before modifying existing code, establish:

- Who imports this? (`node tools/project-graph/query.mjs <file>`)
- What does it depend on?
- Which tests cover it?
- Which API consumers or database entities rely on its shape?

After modifying it: run the tests that cover it **and** its dependents.
After finishing: confirm unrelated functionality still works.

- Never rewrite working code the task did not require changing.
- Never bundle a large refactor into a small feature.
- Never delete a test to make a build pass.

---

## 20. Forbidden behaviours

- Claiming "done" without having executed the tests, typecheck, and lint.
- Reporting success for work that was not verified. Say what you did not verify.
- Committing to `main`.
- Committing secrets, `.env`, or credentials.
- Inventing a visual or product decision the user did not make (section 17).
- Installing "latest" without a compatibility check (sections 3 and 10).
- Using `any` to silence a type error.
- Disabling a lint rule inline without a comment explaining why.
- Skipping validation at the API boundary.
- Enforcing authorization only on the client.
- Storing tokens in `AsyncStorage`.
- Adding a database query on a hot path without an index.
- Creating an issue too vague to complete independently.
- Implementing a dependent feature before its prerequisite exists, without a
  deliberate, documented abstraction.

---

## 21. Commands

```bash
pnpm install            # install workspace dependencies
pnpm dev                # run all dev tasks (Turborepo) — today, the Expo app
pnpm test               # run every workspace test suite
pnpm lint               # root tooling + packages/* + each app's own config
pnpm typecheck          # every workspace that contains TypeScript
pnpm build              # build all workspaces — a no-op until one defines a build
pnpm format             # apply Prettier
pnpm format:check       # verify formatting
pnpm graph              # regenerate the project graph
pnpm graph:check        # regenerate and fail if the committed graph moved
pnpm graph:validate     # enforce architecture rules
pnpm verify             # format:check + lint + typecheck + test + build + graph:validate
```

`pnpm verify` is the PR gate and runs exactly the six steps listed on its line.
`pnpm graph:check` is separate because it needs a clean working tree to compare
against; CI runs it after `verify`.

Both of the former no-ops are real now that `apps/api` has landed (EPIC 1):
`pnpm build` compiles `apps/api` with `nest build`, and `apps/mobile`'s test
script has lost its `--passWithNoTests` flag, so a suite that stops being
discovered fails the gate instead of passing silently.

**`apps/api`'s integration tests need a real database.** They run against
Postgres + PostGIS and Redis — `docker compose up -d` locally, service
containers in CI — and they fail loudly rather than skipping when those are
absent, because a database test that skips is worse than none (§13). So
`pnpm verify` now expects the local stack to be up.
