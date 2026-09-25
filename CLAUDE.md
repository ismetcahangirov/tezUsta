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

**Current phase: an order now runs its whole life on the server.** EPIC 1–7
have landed: the API and the app boot, a phone signs in, the catalogue is
served from the database, a customer keeps addresses, a master has a profile
and a verification trail, an order can be created, read and photographed, and
dispatch broadcasts it to nearby masters until one accepts or the search gives
up. EPIC 8 has its state machine: the assigned master advances the job, the
customer cancels, the master sends it back out, and an admin can drive any
edge the table permits (#134–#137). What EPIC 8 still owes is the money-shaped
half — disputes, payment outcomes and the cancellation policy — most of which
waits on decisions nobody has made yet.

**EPIC 13 has landed: the admin panel exists** (ADR-0043). `apps/admin` is a
Vite + React SPA behind email + password + TOTP, with httpOnly cookies on the
API's own origin. Four roles gate every `/admin` handler, deny by default. An
admin can review and suspend masters, find any order and override it within the
state machine, work the dispute queue, edit the catalogue without an app
release, moderate reviews, read the audit log, watch the operational dashboard
and manage other admins. The first `super_admin` comes from
`pnpm --filter api admin:bootstrap`. `REFUNDED` is refused until EPIC 12, and
reports about a party wait for a mobile reporting flow.

**EPIC 15's first whole-system audit has landed** (#269–#277). Its record is
[`docs/engineering/security-audit-2026-09.md`](docs/engineering/security-audit-2026-09.md),
and what to do when something goes wrong is in
[`docs/engineering/incident-response.md`](docs/engineering/incident-response.md).
It added the following controls:

- The admin surface is decided from the matched route.
- OTP sends have a platform-wide daily ceiling.
- A customer can hold at most a capped number of open orders.
- A master's impossible position jump is refused (ADR-0044).
- Per-account rate-limit buckets come from verified tokens only.
- Every response carries security headers.
- OTP challenges and admin sessions age out.

The epic stays open because it is continuous. The next audit is due when
payments exist.

What is **not** true yet, and is easy to assume from the above: nobody can sign
in for real, because no SMS provider has been chosen. The app _does_ now create
a customer profile — a first-run screen asks for a name and calls
`POST /customers` (ADR-0028, #94) — so the customer surfaces stop answering 404
the moment a real sign-in exists. Work is driven by GitHub Epics and Sub-Issues
— see
[`docs/project-management/roadmap.md`](docs/project-management/roadmap.md).

### Product decisions already settled

These are **decided** — do not re-open them or design around alternatives:

| Decision            | Outcome                                                                                  | ADR                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sign-in             | **Phone + SMS OTP only.** No social sign-in.                                             | [ADR-0008](docs/decisions/ADR-0008-otp-delivery.md)                                                                       |
| Admin sign-in       | **Separate path**: email + password + mandatory TOTP                                     | [ADR-0014](docs/decisions/ADR-0014-admin-authentication.md)                                                               |
| Dispatch            | **Parallel broadcast, first accept wins** (Bolt-style)                                   | [ADR-0009](docs/decisions/ADR-0009-dispatch-model.md)                                                                     |
| Who sets the price  | **The master**; platform takes a commission                                              | [ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)                                                             |
| When price is fixed | **At accept**, from the accepting master; null while searching                           | [ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)                                                                 |
| Order lifecycle     | **14 statuses**; re-dispatch, no-master-found, dispute outcomes                          | [ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md)                                                             |
| Payment methods     | **Both cash and card**                                                                   | [ADR-0007](docs/decisions/ADR-0007-payments.md)                                                                           |
| Maps / geocoding    | **Google Maps Platform**                                                                 | [ADR-0004](docs/decisions/ADR-0004-location-and-maps.md)                                                                  |
| Design system       | **Light + dark, Anybody, lime accent, closed palette**                                   | [ADR-0011](docs/decisions/ADR-0011-design-system.md)                                                                      |
| Component workshop  | **Storybook on React Native Web + Vite**                                                 | [ADR-0012](docs/decisions/ADR-0012-component-workshop.md)                                                                 |
| Shared packages     | **Created on the second consumer**, not speculatively                                    | [ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)                                                              |
| State management    | **Redux Toolkit** for client state, **RTK Query** for server                             | [ADR-0017](docs/decisions/ADR-0017-state-management.md)                                                                   |
| Object storage      | **Cloudflare R2**, S3 API only, size cap enforced at confirm                             | [ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md)                                                         |
| Master verification | **Evidence, scope and review settled**; appeal path still open                           | [ADR-0023](docs/decisions/ADR-0023-master-verification-policy.md)                                                         |
| Customer profile    | **A first-run question asks for a name**; the rest of first run is open                  | [ADR-0028](docs/decisions/ADR-0028-customer-profile-at-first-run.md)                                                      |
| In-order messaging  | **A conversation belongs to one order**, opens at accept, read-only at a terminal status | [ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)                                                                 |
| Calling             | **In-app voice over LiveKit**, no masked PSTN, no video; the RN pairing is unproven      | [ADR-0034](docs/decisions/ADR-0034-in-app-voice-calls.md)                                                                 |
| Tracking map        | **A map card under the status card**, only while accepted or on the way                  | [ADR-0035](docs/decisions/ADR-0035-customer-tracking-map.md)                                                              |
| Master work surface | **Home shows the job or the offer feed; the job is one pushed screen**                   | [ADR-0036](docs/decisions/ADR-0036-master-work-surface.md)                                                                |
| Call screens        | **One full-screen modal, four phases, `#111`/`#fff` in both themes**; ships dark         | [ADR-0040](docs/decisions/ADR-0040-call-screens.md), [ADR-0041](docs/decisions/ADR-0041-call-surface-fixed-appearance.md) |
| Reviews             | **Optional, blind, 7-day window, counted at reveal**; no public comments yet             | [ADR-0042](docs/decisions/ADR-0042-review-policy.md)                                                                      |
| Admin panel         | **Four roles, password + TOTP, invitation-only, `REFUNDED` withheld until EPIC 12**      | [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md)                                                                 |

### Decisions still open

This is the whole list. If a document presents something else as open, that
document is stale; if it presents one of the decisions above as open, it is
wrong. Nothing here can be researched — each needs the owner, a lawyer, or a
commercial relationship.

| Open decision                                                   | Blocks                           |
| --------------------------------------------------------------- | -------------------------------- |
| 🔴 **SMS provider + sender ID**                                 | Completing EPIC 2 — real sign-in |
| **Does TezUsta hold customer funds?** (needs legal)             | EPIC 12                          |
| Payment provider                                                | EPIC 12                          |
| Commission rate + price guardrails                              | EPIC 12                          |
| Master verification **appeal path** and re-verification cadence | Polish, not features             |
| Cancellation rules and penalties                                | EPIC 8                           |
| Hosting / cloud provider                                        | EPIC 17                          |
| Account recovery when the phone number is lost                  | Launch                           |
| Languages at launch                                             | Launch                           |
| Owner art: app icon, splash, map style, illustration            | Polish, not features             |

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
✓ admin/    Vite + React SPA admin panel, same origin as the API (ADR-0043)
packages/
✓ types/              API contracts shared by apps/api, apps/mobile and apps/admin
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
([ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)). `packages/types`
reached that moment in EPIC 3, when `apps/mobile` began consuming the service
catalogue's response shapes (#33); the rest have not. Until the second consumer
arrives, the code lives in its single consumer, behind the same interface it
would have had as a package:

| Concern                         | Lives in                                              | Moves to              |
| ------------------------------- | ----------------------------------------------------- | --------------------- |
| Geocoding, SMS, storage, config | `apps/api/src/infra/<domain>/`                        | `packages/config`     |
| Zod schemas                     | `apps/api/src/**/*.schema.ts`                         | `packages/validation` |
| Design system and components    | `apps/mobile/src/theme`, `apps/mobile/src/components` | `packages/ui`         |

The design tokens now have a second consumer in `apps/admin`, which holds a
copy of `design-tokens.json` guarded by a test that fails if the two drift
(`apps/admin/src/theme/design-tokens.test.ts`). Moving them into a package is
the ADR-0016 step still owed; the components themselves are not shared — one
set is React Native, the other DOM.

**A contract crossing the HTTP boundary goes in `packages/types`.** A row type,
a Drizzle inference, a Nest type and a React type do not — that package is
imported by a React Native bundle and by a server that talks to Postgres, and
it has to stay uninteresting to both. It ships TypeScript source and has no
build step, which holds only while every export is a type; the first runtime
value added there makes it a real dependency of the app bundle. `auth.types.ts`
is still transcribed by hand in `apps/mobile/src/auth/` and is the obvious next
thing to move, in its own commit.

The package now carries `Address`, `Customer`, `Master`, `MasterDocument`, the
service catalogue, `Order` and `OrderPhoto`, and `apps/mobile` imports from it
directly. A new contract that crosses HTTP goes there rather than being retyped
on the client — the transcription in `auth/` is the exception that predates the
package, not the pattern.

The interface is designed as if it were already a package — no vendor SDK type
crosses the boundary — so extraction is later a file move, not a redesign.

Read before making an architectural change:

| Document                                                                                   | What it covers                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md) | System shape, boundaries, invariants        |
| [`docs/architecture/technology-stack.md`](docs/architecture/technology-stack.md)           | **Every pinned version and why**            |
| [`docs/architecture/system-design.md`](docs/architecture/system-design.md)                 | Runtime topology, scaling model             |
| [`docs/architecture/frontend-architecture.md`](docs/architecture/frontend-architecture.md) | Expo app and admin panel, state management  |
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
- `apps/mobile` may not import `apps/api` or `apps/admin`
- `apps/admin` may not import `apps/api` or `apps/mobile`
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
- the Google Maps style JSON. Where the customer's tracking map sits, when it
  appears and what it says when the position is stale or missing are settled
  ([ADR-0035](docs/decisions/ADR-0035-customer-tracking-map.md), 23 September
  2026); its art is not. It ships the platform's own light and dark map, interim
  token-built markers and placeholder copy, all listed there for acceptance
- illustration and empty-state art
- motion and transitions
- the **navigation pattern** for the **master** beyond the job flow. Settled
  for that flow
  ([ADR-0036](docs/decisions/ADR-0036-master-work-surface.md), 23 September
  2026): the master stays on one stack, home shows the current job or else the
  offer feed under the availability card, and the job is one pushed screen at
  `(master)/job`. A job history, and with it a tab bar, is still the owner's.
  The **customer's** root is settled: a two-tab bar — the catalogue
  and the order list — with order creation, one order and saved addresses
  pushed over it
  ([ADR-0030](docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md),
  22 September 2026). The master keeps a single stack until they have a second
  destination worth returning to (ADR-0036). Already settled
  before that: order creation is one screen with local steps — service, then the
  problem and its photos, then the address, then a confirmation (18 September 2026) — and the order screen is one status card at `(customer)/order/[id]`
  ([ADR-0029](docs/decisions/ADR-0029-customer-order-screen.md)). Settings is
  the customer's third tab and, for the master, a control on their home
  ([ADR-0031](docs/decisions/ADR-0031-where-settings-is-reached-from.md), 22
  September 2026) — one screen, two routes, because a tab can only name a route
  inside its own directory
- the conversation screen is **settled**
  ([ADR-0037](docs/decisions/ADR-0037-conversation-screen.md), 23 September
  2026). It is pushed at `(customer)/order/[id]/chat` and `(master)/chat/[orderId]`.
  Bubbles use `inverse-surface` for the user's own messages and `surface` for
  the other party's, delivery state is shown in words, and the unread badge
  sits on the order's row, the order screen and the job screen. Its copy is
  still a placeholder, and its empty-state content is still the owner's
- the **onboarding flow** — what a first-run user is shown, and in what order.
  Settled for **one question only**: a first-run customer is asked what to call
  them, because `POST /customers` needs a display name and phone sign-in carries
  none ([ADR-0028](docs/decisions/ADR-0028-customer-profile-at-first-run.md),
  #94). A welcome, artwork, a role chooser, a tour and any second field are
  still entirely the owner's, and the copy on that one screen is a placeholder
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

`pnpm --filter admin dev` serves the admin panel on `http://localhost:5173` and
proxies `/api/*` to the API on port 3000 with the prefix stripped (ADR-0043 § 4).
Its tests are Vitest + Testing Library over a fake `fetch` and need no database.

Both of the former no-ops are real now that `apps/api` has landed (EPIC 1):
`pnpm build` compiles `apps/api` with `nest build` and `apps/admin` with
`vite build`, and `apps/mobile`'s test
script has lost its `--passWithNoTests` flag, so a suite that stops being
discovered fails the gate instead of passing silently.

**`pnpm test` runs the workspaces' suites one at a time** (`--concurrency=1`).
Not a style choice: `apps/api`'s suite is a few thousand Postgres-backed
assertions and `apps/mobile`'s is seventy-odd React Native files, and run
together they saturate the same cores. Both then start failing their per-test
deadlines — in unrelated files, on their _first_ test, with every one of them
passing when its suite runs alone. That is the worst kind of red gate: it
points at code nobody changed. Serialising costs a few minutes of wall clock
and keeps both deadlines meaning "this test hung" rather than "the machine was
busy" (issue #170).

**`apps/api`'s integration tests need a real database.** They run against
Postgres + PostGIS and Redis — `docker compose up -d` locally, service
containers in CI — and they fail loudly rather than skipping when those are
absent, because a database test that skips is worse than none (§13). So
`pnpm verify` now expects the local stack to be up.
