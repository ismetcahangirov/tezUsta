# Technology stack

Status: **accepted** for the foundation phase
Last verified: **2026-09-14**

Every version here was checked against a primary source — the npm registry's
own metadata (`peerDependencies`, `engines`, `dist-tags`) and official
documentation — not against recollection. Where we are deliberately _behind_
the newest published release, the reason is recorded.

**How to re-verify any claim in this document:**

```bash
curl -s https://registry.npmjs.org/-/package/<pkg>/dist-tags        # what "latest" really is
curl -s https://registry.npmjs.org/<pkg>/<version> | jq .peerDependencies
```

---

## 1. The three pins that are not "latest"

These are the traps. Each one would install cleanly and then cause damage.

### 1.1 TypeScript 6.0.3, not 7.0.2

`typescript@7.0.2` is the current `latest` dist-tag (published 2026-07-08).
We pin **6.0.3**.

**Evidence:**

| Package                                     | Declared support               |
| ------------------------------------------- | ------------------------------ |
| `typescript-eslint@8.70.0` (latest)         | `typescript: ">=4.8.4 <6.1.0"` |
| `typescript-eslint@8.70.1-alpha.0` (canary) | `typescript: ">=4.8.4 <6.1.0"` |
| `@nestjs/schematics@12.0.1`                 | `typescript: ">=6.0.0"`        |

The intersection of "NestJS 12 needs ≥ 6.0" and "typescript-eslint supports
< 6.1" is **TypeScript 6.0.x**. There is no typescript-eslint release — stable
or canary — that supports TypeScript 7.

**Consequence of ignoring this:** installing TypeScript 7 does not fail. It
silently disables every type-aware lint rule (`no-floating-promises`,
`no-misused-promises`, `no-unsafe-*`) — precisely the rules that catch unhandled
async failures in request handlers and queue workers.

**Revisit when:** typescript-eslint publishes a release whose peer range admits
TypeScript 7. Re-check with the `curl` command above before upgrading.

### 1.2 Expo SDK 57, not 58

`expo@58.0.0-preview.0` exists. It is published under the **`preview`**
dist-tag. The **`latest`** dist-tag is `57.0.22`, and
[docs.expo.dev/versions/latest](https://docs.expo.dev/versions/latest/)
documents SDK 57 as current.

SDK 57 pairs with **React Native 0.86.x** and **React 19.2.3** (per Expo's own
version service, `https://api.expo.dev/v2/versions/latest`).

Note that Expo now versions its own modules in lockstep with the SDK:
`expo-router@57.x`, `expo-location@57.x`, `expo-notifications@57.x`,
`expo-secure-store@57.x`. Do not mix a 58.x module into a 57 app.

**Rule:** React Native and React versions are chosen _by_ the Expo SDK, never
independently. Use `npx expo install` (which consults Expo's compatibility
service) rather than `pnpm add` for any Expo-managed package.

### 1.3 Tailwind CSS 3.4.17, not 4.3.3

This is the most dangerous of the three, because the package manager will not
warn you.

`nativewind@4.2.6` declares `peerDependencies: { "tailwindcss": ">3.3.0" }`.
Tailwind `4.3.3` satisfies that range, so `pnpm install` succeeds. But
[NativeWind's official installation guide](https://www.nativewind.dev/docs/getting-started/installation)
specifies `tailwindcss@^3.4.17`. NativeWind v4 targets the Tailwind 3 engine;
Tailwind 4 replaced the configuration and compilation model entirely.

NativeWind **v5** does support the newer model, but its own documentation states
it is a pre-release and **"not intended for production use."**

**Decision:** `nativewind@4.2.6` + `tailwindcss@3.4.17`, pinned exactly.
**Revisit when:** NativeWind v5 reaches a stable release.

**This is the general lesson for this repository:** a satisfied peer range is
not evidence of support. Check the documentation too.

---

## 2. Mobile

| Package                      | Version   | Status      | Why                                                                                                                                                                                                         |
| ---------------------------- | --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo`                       | `57.0.22` | installed   | Current stable SDK (§1.2). Managed workflow + EAS Build.                                                                                                                                                    |
| `react-native`               | `0.86.3`  | installed   | Chosen by Expo SDK 57. Do not set independently.                                                                                                                                                            |
| `react`                      | `19.2.3`  | installed   | Chosen by Expo SDK 57.                                                                                                                                                                                      |
| `expo-router`                | `57.0.21` | installed   | File-based routing, first-party, typed routes.                                                                                                                                                              |
| `nativewind`                 | `4.2.6`   | installed   | Tailwind-style utilities in RN (§1.3).                                                                                                                                                                      |
| `tailwindcss`                | `3.4.17`  | installed   | Required by NativeWind v4 (§1.3).                                                                                                                                                                           |
| `expo-secure-store`          | `57.0.4`  | installed   | Keychain / Keystore-backed token storage (§6).                                                                                                                                                              |
| `@reduxjs/toolkit`           | `2.12.0`  | installed   | Client state; RTK Query, which ships inside it, owns server state.                                                                                                                                          |
| `react-redux`                | `9.3.0`   | installed   | The React binding for the store.                                                                                                                                                                            |
| `@expo-google-fonts/anybody` | `0.4.2`   | installed   | The design system typeface, bundled — no CDN at launch.                                                                                                                                                     |
| `lucide-react-native`        | `1.46.0`  | installed   | Icon set; stroke and colour forced through tokens.                                                                                                                                                          |
| `react-native-svg`           | `15.15.4` | installed   | Required by Lucide. Chosen by Expo SDK 57.                                                                                                                                                                  |
| `expo-notifications`         | `57.0.20` | installed   | Push via Expo's push service (EPIC 10, issue #145).                                                                                                                                                         |
| `expo-constants`             | `57.0.19` | installed   | App version and device name. Bumped from `57.0.18` because `expo-notifications@57.0.20` depends on `~57.0.19`, and a second nested copy of a native module is not something Expo autolinking resolves well. |
| `expo-location`              | `57.0.17` | **planned** | Foreground + background location (EPIC 9).                                                                                                                                                                  |
| `react-native-maps`          | `1.27.2`  | installed   | Map rendering (§5), the customer's tracking map (#172). The SDK 57 version, not the `1.29.2` first planned (ADR-0035).                                                                                      |

**"planned" means the version was chosen but the package is not in
`apps/mobile/package.json` yet.** Install it with `npx expo install`, which
consults Expo's compatibility service, and re-check the pin at that moment
rather than trusting the number above. The distinction matters because this
table is otherwise read as a description of the shipped app.

### Component workshop

| Package                            | Version  | Why                                                                          |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `storybook`                        | `10.6.0` | Component workshop ([ADR-0012](../decisions/ADR-0012-component-workshop.md)) |
| `@storybook/react-native-web-vite` | `10.6.0` | Renders RN components in a browser                                           |
| `vite`                             | `8.3.0`  | Storybook's builder                                                          |

`@storybook/react-native` (the on-device runtime) was rejected: version `10.6.0`
declares `react-native-safe-area-context` at **exactly `5.8.0`**, while Expo SDK
57 pins `~5.7.0`. It is not installable here. Details in ADR-0012.

### Test stack

| Package                         | Version  | Why                                                      |
| ------------------------------- | -------- | -------------------------------------------------------- |
| `jest`                          | `29.7.0` | `jest-expo@57.0.5` builds on the Jest 29 packages        |
| `jest-expo`                     | `57.0.5` | Expo's preset — transform, resolver, and mocks           |
| `@testing-library/react-native` | `14.0.1` | **`render` and `fireEvent` are async in v14** (React 19) |
| `test-renderer`                 | `1.2.0`  | v14 peer; replaces `react-test-renderer`                 |

### Why one binary for both roles

Customer and master ship in a **single app**, with the experience switched by
role. A master is often also a customer, and two binaries doubles build, release,
and support cost for no user benefit. The route tree is segregated by role group,
which is an organisational and UX affordance — **authorization is enforced
server-side on every request and never by the router** (§6,
[`frontend-architecture.md`](frontend-architecture.md)).

### State management: Redux Toolkit + RTK Query

**Decision:** `@reduxjs/toolkit` owns client state. **RTK Query** owns server
state. `react-redux` provides the binding.
[ADR-0017](../decisions/ADR-0017-state-management.md) records the decision, the
reasoning, and the mapping from what it replaced.

**RTK Query is not a separate package.** It ships inside `@reduxjs/toolkit` and
is imported from `@reduxjs/toolkit/query/react`. Installing anything else for it
adds a dependency the repository already has.

**Why:** the overwhelming majority of TezUsta's state _is_ server state —
orders, masters, services, statuses. That state needs caching, deduplication,
retry, and invalidation, which is RTK Query's job. Slices hold only what the
server does not own: the selected role, an in-progress order draft, map camera
position, UI preferences.

**Evidence:**

| Package                   | Declared peers                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@reduxjs/toolkit@2.12.0` | `react: "^16.9 \|\| ^17 \|\| ^18 \|\| ^19"`, `react-redux: "^7.2.1 \|\| ^8.1.3 \|\| ^9.0.0"` — both **optional** |
| `react-redux@9.3.0`       | `react: "^18 \|\| ^19"`, `@types/react: "^18.2.25 \|\| ^19"`, `redux: "^5.0.0"`                                  |

This repository pins React `19.2.3` and `@types/react` `19.2.18`, so both sit
inside the declared ranges. `redux` arrives as a transitive dependency of the
toolkit, at the major the binding asks for.

**Rule:** if the server is the source of truth, it does not belong in a slice.
That boundary predates this choice and survived it — only the library changed.

---

## 3. Backend

**`apps/api` does not exist yet.** Every pin in this section is a verified
choice waiting for the workspace, not an installed dependency — re-run the
`curl` checks above at the moment the workspace is created, because these
numbers are months old by then.

| Package                    | Version  | Why                                                                  |
| -------------------------- | -------- | -------------------------------------------------------------------- |
| `@nestjs/core`             | `12.0.1` | Modular architecture, DI, first-class WebSocket + queue integration. |
| `@nestjs/platform-fastify` | `12.0.1` | Fastify adapter.                                                     |
| `fastify`                  | `5.12.4` | Fastify 6 is alpha; Nest 12's adapter targets Fastify 5.             |
| `zod`                      | `4.6.5`  | Runtime validation at every API boundary.                            |
| `bullmq`                   | `6.3.7`  | Background jobs and delayed work on Redis (ADR-0025).                |
| `@nestjs/bullmq`           | `12.0.0` | Nest module, queue and `@Processor` wiring for BullMQ (ADR-0025).    |
| `ioredis`                  | `6.0.0`  | Redis client (BullMQ's expected driver).                             |

**`zod` needs a deliberate check before it is introduced.** No workspace
declares it today, but the tree already resolves a **transitive `zod@3.25.76`**.
Under `nodeLinker: hoisted` a second major version does not simply sit beside
the first — whichever copy wins the hoist is the one an undeclared import
resolves to, and Zod 3 and 4 have incompatible APIs. Declare `zod@4.6.5`
explicitly in `apps/api`, and verify what resolves after installing rather than
assuming.

`@nestjs/core@12` declares `engines: { node: ">= 20" }`. The repository targets
**Node 24 LTS**: root `package.json` declares
`engines: { node: ">=24.0.0", pnpm: ">=11.0.0" }`, `.nvmrc` pins `24`, and CI
uses the same. That also satisfies `dependency-cruiser@18.3.0`'s
`engines: { node: "^22||^24||>=26" }`.

### Why Fastify over Express

**Decision:** NestJS on the Fastify adapter.

**Why:** higher throughput and lower per-request overhead than Express, with
schema-based serialization. TezUsta's hot paths — location updates and nearby
lookups — are high-frequency and small-payload, which is where that difference
is actually felt.

**Trade-off:** a smaller middleware ecosystem than Express, and some Nest
recipes assume Express. Both are acceptable: Nest's abstractions cover the
middleware we need, and the Fastify plugin ecosystem covers the rest
(`@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart`).

**Revisit if:** a required integration exists only as Express middleware. So far
none does.

### Why NestJS at all

A marketplace backend grows a lot of modules (auth, orders, matching, payments,
notifications, admin). Nest's module system, DI, and guard/interceptor pipeline
give that structure by default, which matters more than raw framework minimalism
when the codebase outlives its first author. The cost is boilerplate and
decorator metadata — accepted deliberately.

---

## 4. Database

Also **planned for `apps/api`** — verified pins, not installed packages.

| Package       | Version   | Why                                        |
| ------------- | --------- | ------------------------------------------ |
| PostgreSQL    | **17.x**  | Primary datastore.                         |
| PostGIS       | **3.5.x** | Spatial indexing and radius search (§4.1). |
| `drizzle-orm` | `0.45.2`  | Typed SQL-first query builder.             |
| `drizzle-kit` | `0.31.10` | Migration generation.                      |
| `pg`          | `8.23.0`  | Postgres driver.                           |

`drizzle-orm@1.0.0-beta.22` exists under the `beta` tag. We use the stable
`0.45.2`.

### Why Drizzle over Prisma

**Decision:** Drizzle ORM.

**Why:** TezUsta's defining query is a spatial one — "verified, available
masters offering service X within N metres of this point, ordered by distance."
That is a PostGIS query. Drizzle is SQL-first: raw SQL composes naturally into
the query builder while staying typed. It also has no separate engine binary,
which keeps the container small and startup fast.

**Alternatives considered:** Prisma — better DX for simple CRUD, but historically
awkward with PostGIS and raw spatial SQL, and it adds a query engine to the
runtime. TypeORM — mature but its migration story and typing are weaker. Kysely
— very close to Drizzle in philosophy; Drizzle wins on schema-as-code and its
migration tooling.

**Trade-off:** Drizzle is pre-1.0 and its API still moves. Migrations are
generated but **must be reviewed by hand** before being applied — treat
`drizzle-kit generate` as a draft, never as a finished artifact.

### 4.1 PostGIS support is native in Drizzle — verified

The Drizzle documentation page for Postgres column types does not surface this
clearly, and a plain reading of it suggests PostGIS needs a custom type. That is
wrong. Inspecting the published package proves it:

```
drizzle-orm@0.45.2 → pg-core/columns/postgis_extension/geometry.d.ts

export interface PgGeometryConfig<T extends 'tuple' | 'xy'> {
  mode?: T;
  type?: 'point' | (string & {});
  srid?: number;
}
export declare function geometry(name, config?): ...
```

and `pg-core/indexes` supports `gist`. So:

```ts
export const masterLocations = pgTable(
  'master_locations',
  {
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id),
    position: geometry('position', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The index is built on the CAST, not on the bare column — see the
    // correction below.
    index('master_locations_position_idx').using('gist', sql`(${t.position}::geography)`),
  ],
);
```

#### Correction: index the cast, not the column — measured

**A GiST index on the bare `geometry` column does not accelerate a
`geography`-cast query.** PostGIS registers a separate operator class for
`geography`, so `ST_DWithin(position::geography, ...)` — the canonical
nearby-masters query in
[`database-architecture.md`](database-architecture.md) § The nearby-masters
query — cannot use an index built on `position` alone. It needs an index built
on the same expression the query uses.

Measured on this stack (PostgreSQL 17.5 + PostGIS 3.5, 50 000 rows,
`EXPLAIN (ANALYZE, BUFFERS)`):

| Index                         | Plan              | Time       |
| ----------------------------- | ----------------- | ---------- |
| `gist(position)`              | **Seq Scan**      | **824 ms** |
| `gist((position::geography))` | Bitmap Index Scan | **2.0 ms** |

A `geography`-typed column with a plain GiST index also uses an index, but
`drizzle-orm@0.45.2` ships **no `geography` column helper** — only `geometry`
(verified in `pg-core/columns/postgis_extension/`, which contains `geometry.*`
and nothing else) — so that route needs a `customType`. Keeping the native
`geometry` column and indexing the cast is the cheaper correct answer.

**Also verified against the shipped package:** `geometry('position', { type:
'point', mode: 'xy', srid: 4326 })` emits the DDL type `geometry(point)` —
`PgGeometryObject.getSQLType()` ignores the `srid` config and emits no SRID
typmod. If the column must be constrained to SRID 4326 at the database level,
that constraint has to be written into the migration by hand; Drizzle will not
generate it.

This is the same lesson as §4.1 itself: the artifact wins (CLAUDE.md §9). Here
it was `EXPLAIN` that settled it, not a documentation page.

**This is the reason CLAUDE.md §9 says the artifact beats the doc.** When a
documentation page and the shipped package disagree, inspect the package.

PostGIS itself must be enabled per database: `CREATE EXTENSION IF NOT EXISTS
postgis;` — this belongs in the first migration.

**Why PostGIS rather than a bounding box or the cube/earthdistance extensions:**
a GiST index over `geography` gives correct great-circle distance and an indexed
`ST_DWithin`, so the nearby query touches an index instead of every row.
Bounding-box maths in application code degrades to a full table scan and is
wrong near the poles and the antimeridian — irrelevant for Baku, but the cost of
doing it correctly is one extension.

**Never** compute distance by loading all masters and sorting in Node.

---

## 5. Maps, geocoding, and location

| Package             | Version   | Status      | Role                                            |
| ------------------- | --------- | ----------- | ----------------------------------------------- |
| `expo-location`     | `57.0.17` | **planned** | Permissions, foreground and background position |
| `react-native-maps` | `1.27.2`  | installed   | Map rendering                                   |

### Why react-native-maps, not expo-maps

`expo-maps` is first-party and modern (SwiftUI / Jetpack Compose), but its own
documentation states two disqualifying facts:

1. **"This library is currently in alpha and will frequently experience breaking changes."**
2. On iOS it renders **Apple Maps only** — "While Google provides a Google Maps
   SDK for iOS, Expo Maps supports it exclusively on Android."

A dispatch marketplace needs the same map data, same place IDs, and same
geocoding results on both platforms. Two different map providers means two
different sets of coordinates for the same address.

`react-native-maps@1.29.2` renders Google Maps on both platforms and is stable.

**Revisit when:** expo-maps leaves alpha and supports a single provider across
both platforms.

### Geocoding provider — **Google Maps Platform** (decided)

Decided by the project owner. **Baku address coverage is the requirement that
cannot be compromised, and Google is the only candidate where it is not in
question.** Cost is manageable at launch volume and stays renegotiable; wrong
addresses at launch are not recoverable.

The candidates that were weighed:

| Provider                      | For                                                                                                            | Against                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Google Maps Platform**      | Best-in-class Azerbaijani address and POI coverage; one provider for maps, geocoding, distance matrix, and ETA | Most expensive at volume; billing account and per-platform key restrictions required                                    |
| **Mapbox**                    | Cheaper at volume; excellent custom styling; strong offline support                                            | Azerbaijani street-level address coverage is not confirmed — Mapbox's own coverage announcements do not list Azerbaijan |
| **OpenStreetMap / Nominatim** | Free; OSM Baku coverage is reasonable                                                                          | Nominatim's public endpoint forbids production use; self-hosting is real operational work; no ETA or routing            |

**Still behind a provider interface**, and no call site imports a vendor SDK
directly — prices and terms change, so the choice must remain reversible in one
file. The interface lives in `apps/api/src/infra/geo/` and moves to
`packages/config` when a second workspace needs it; a package with one consumer
buys nothing ([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)).

**Cost control is the operational concern.** The geocode cache, keyed on the
normalised address, is the single largest lever on the bill. Matching also never
calls a routing API: ranking uses PostGIS straight-line distance, and Distance
Matrix is called once, for the assigned master, to show an ETA.

Recorded in [`ADR-0004`](../decisions/ADR-0004-location-and-maps.md).

---

## 6. Authentication

This section is the **customer and master** path. Admin accounts use a separate
credential path — email + password + mandatory TOTP, a distinct `admin_users`
table, an 8-hour rotating refresh, a 30-minute idle timeout, and an httpOnly
cookie rather than a bearer token
([ADR-0014](../decisions/ADR-0014-admin-authentication.md),
[`authentication.md`](authentication.md) § Admin authentication).

| Choice                | Decision                                                         |
| --------------------- | ---------------------------------------------------------------- |
| **Sign-in method**    | **Phone number + SMS OTP. No other consumer sign-in path.**      |
| Scheme                | Short-lived JWT access token + long-lived rotating refresh token |
| Access TTL            | 15 minutes                                                       |
| Refresh TTL           | 30 days, rotated on every use                                    |
| Mobile storage        | **`expo-secure-store`** (iOS Keychain / Android Keystore)        |
| Refresh token at rest | Hashed in Postgres, one row per device session                   |

**`AsyncStorage` is forbidden for tokens.** It is unencrypted plaintext readable
by any process with filesystem access on a rooted or jailbroken device — the
realistic threat for a marketplace that moves money.

Rotation with reuse detection: presenting an already-used refresh token
invalidates the entire session family. That converts a stolen token from
persistent access into a single-use window plus an alarm.

Roles (`customer`, `master`, `admin`) are claims in the access token **and** are
re-checked server-side against the database on every authorization decision. A
token claim is a cache, not an authority.

**Consumer sign-in is phone + OTP only.** Social sign-in was considered and
rejected — the phone number is simultaneously the identity and the contact
channel, because the customer and the master must be able to call each other
during a job. One authentication vector on the consumer surface, not two
([`ADR-0008`](../decisions/ADR-0008-otp-delivery.md)).

**The SMS provider is still open, and it blocks completing EPIC 2** — real
sign-in, not the implementation. EPIC 2 builds the sender behind a provider
interface against a stub (`SMS_PROVIDER=stub`), so the rest of authentication
proceeds; with OTP as the only consumer sign-in path, nobody can actually enter
the app until a provider is chosen.

Details: [`authentication.md`](authentication.md).

---

## 7. Caching, queues, realtime

| Component               | Choice              | Used for                                                                   |
| ----------------------- | ------------------- | -------------------------------------------------------------------------- |
| Cache / ephemeral state | **Redis 7.x**       | Master presence, rate limiting, matching locks, WebSocket pub/sub fan-out  |
| Queue                   | **BullMQ 6.3.7**    | Delayed dispatch deadlines (ADR-0025); later push, SMS/OTP, reconciliation |
| Realtime                | **socket.io 4.8.3** | Order status, master location, notifications                               |

**Redis holds no permanent business data.** Anything that must survive a Redis
restart lives in Postgres. Presence and locks are legitimately ephemeral; an
order is not.

The Redis adapter exists so the API can run more than one instance — without
it, a client connected to instance A never receives an event published on
instance B. Designing for that at the start is far cheaper than retrofitting.

**The realtime pins (issue #166, [ADR-0032](../decisions/ADR-0032-realtime-transport.md)):**

| Package                            | Version  | Why this one                                                                                                                                                                                             |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/websockets`               | `12.0.1` | **Not `12.0.0`**, which still declares `@nestjs/core: ^11.0.0` — a real peer conflict. Not `12.0.4` either: it would sit a patch ahead of `@nestjs/core`, `common` and `platform-fastify`, all `12.0.1`. |
| `@nestjs/platform-socket.io`       | `12.0.1` | Same line. Attaches to the API's existing Fastify port; no second listener.                                                                                                                              |
| `socket.io`                        | `4.8.3`  | An **exact regular dependency** of the line above, not a peer — so the version is not ours to choose. Declared anyway because the gateway imports its types and `no-non-package-json` counts that.       |
| `@socket.io/redis-streams-adapter` | `0.3.1`  | Streams rather than pub/sub: a Redis blip under pub/sub silently discards events and no client ever learns to refetch. A 0.x pin, mitigated by constructing the adapter in exactly one file.             |

`ioredis@6` support was **verified by execution**, not from metadata: neither
Redis adapter declares an `ioredis` peer at all, so no registry check can
answer the question.

Location update frequency is a **budget**, not a stream — see
[`realtime-architecture.md`](realtime-architecture.md).

---

## 8. File storage

Problem photos go to **S3-compatible object storage**, never into Postgres.
Storing image bytes in the database inflates backups, evicts useful pages from
cache, and makes replication slow.

The upload path is: client requests a **presigned PUT** → uploads directly to
storage → sends the resulting key to the API. The API never proxies image bytes.

Server-side controls: content-type allow-list, size cap, and validation of the
actual leading bytes rather than the declared MIME type (a client-declared
content type is an assertion, not a fact).

Provider is an open decision — see [`ADR-0005`](../decisions/ADR-0005-object-storage.md).
Cloudflare R2 is the current recommendation (no egress fees, S3-compatible API),
but it is not yet confirmed.

---

## 9. Testing

| Layer                      | Tool                                             | Version             | Status                   |
| -------------------------- | ------------------------------------------------ | ------------------- | ------------------------ |
| Mobile unit / component    | `jest` + `@testing-library/react-native`         | `29.7.0` / `14.0.1` | installed                |
| Backend unit + integration | `vitest`                                         | `5.0.0`             | **planned — unverified** |
| HTTP integration           | `supertest`                                      | `7.2.2`             | **planned — unverified** |
| Database integration       | Testcontainers-style disposable Postgres+PostGIS | —                   | planned                  |
| E2E (mobile)               | **Maestro**                                      | —                   | planned                  |

**`jest` is pinned at `29.7.0`, not 30.x.** `jest-expo@57.0.5` builds on the
Jest 29 packages, and
[`../engineering/dependency-policy.md`](../engineering/dependency-policy.md)
forbids the upgrade for that reason. A Jest 30 number anywhere in this document
is a mistake, not an alternative.

**The `vitest` and `supertest` numbers are not verified pins.** Unlike every
version in §1, neither has an evidence block, neither is installed, and the
workspace they belong to (`apps/api`) does not exist. Treat them as a starting
point to check with the `curl` commands above when that workspace is created —
not as a checked compatibility decision.

### Why Jest on mobile but Vitest on the backend

Expo ships and maintains `jest-expo`, which configures the React Native
transform, module mocks, and asset handling correctly. Fighting that to use
Vitest buys nothing.

The backend has no React Native constraint, so Vitest's speed, native ESM
support, and simpler configuration win there. Two runners in one monorepo is a
real cost, accepted because each is clearly better in its own half.

### Why Maestro over Detox

**Decision:** Maestro.

**Why:** Expo documents Maestro as the E2E path for
[EAS Workflows](https://docs.expo.dev/build-reference/e2e-tests/) — it is the
first-party supported route. Tests are declarative YAML, there is no native test
harness to link into the app, and it tolerates Expo's managed workflow and CNG
prebuild without custom native configuration.

**Alternatives considered:** Detox (`20.51.4`) is more powerful and offers true
grey-box synchronisation, but it requires native project configuration that
fights the managed workflow, and Expo does not document it as the supported
path. Popularity is not the criterion — supported integration is.

**Trade-off:** Maestro's assertions are coarser than Detox's. Accepted: E2E
covers a handful of critical journeys (create order → match → accept → complete),
and fine-grained assertions belong in unit and integration tests anyway.

---

## 10. Tooling

| Tool                 | Version   | Role                                                                         |
| -------------------- | --------- | ---------------------------------------------------------------------------- |
| `pnpm`               | `11.11.0` | Workspaces. `nodeLinker: hoisted` for React Native native module resolution. |
| `turbo`              | `2.10.12` | Task orchestration and caching.                                              |
| `eslint`             | `10.10.0` | Flat config.                                                                 |
| `typescript-eslint`  | `8.70.0`  | Type-aware rules (constrains TypeScript — §1.1).                             |
| `prettier`           | `3.9.6`   | Formatting.                                                                  |
| `dependency-cruiser` | `18.3.0`  | Project graph **and** architecture rule enforcement.                         |

### Why pnpm + Turborepo, not Nx

**Decision:** pnpm workspaces + Turborepo.

**Why:** Turborepo is a task runner with caching and nothing more. It does not
own the repository's structure, generate code, or require plugins per framework.
For a two-app monorepo with a handful of shared packages, that is the right
amount of tool.

**Alternative considered:** Nx is more capable — it has a first-class project
graph, affected-task detection, and generators. It is also substantially more
opinionated, and adopting it means adopting its plugin model for Expo and Nest.
We get the graph capability we actually need from dependency-cruiser at a
fraction of the commitment.

**Revisit if:** the repository grows past roughly ten workspaces, or
affected-only CI becomes a bottleneck.

### Why dependency-cruiser, not Madge

**Decision:** dependency-cruiser.

**Why:** it is the only candidate that does both jobs — emits a machine-readable
graph _and_ enforces architectural boundaries as CI-failing rules. A graph that
nobody enforces decays into a picture.

**Decisive technical fact:** `madge@8.0.0` declares
`peerDependencies: { "typescript": "^5.4.4" }`, which conflicts directly with
this repository's TypeScript 6 pin. `dependency-cruiser@18.3.0` declares no
TypeScript peer at all (it parses with its own acorn-based pipeline) and
`engines: { node: "^22||^24||>=26" }`, which matches our Node 24.

Full reasoning: [`ADR-0006`](../decisions/ADR-0006-project-graph-tooling.md).

---

## 11. Product decisions — settled and outstanding

### Settled by the project owner (2026-09-14)

| Decision           | Outcome                                                | ADR                                                         |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| Sign-in method     | **Phone + SMS OTP only** (no social sign-in)           | [ADR-0008](../decisions/ADR-0008-otp-delivery.md)           |
| Maps / geocoding   | **Google Maps Platform**                               | [ADR-0004](../decisions/ADR-0004-location-and-maps.md)      |
| Dispatch model     | **Parallel broadcast, first accept wins** (Bolt-style) | [ADR-0009](../decisions/ADR-0009-dispatch-model.md)         |
| Who sets the price | **The master**; platform takes a commission            | [ADR-0010](../decisions/ADR-0010-pricing-and-commission.md) |
| Payment methods    | **Both cash and card**                                 | [ADR-0007](../decisions/ADR-0007-payments.md)               |

### Still outstanding

Each is blocked on information engineering research cannot supply.

| Decision                                       | Blocked on                                                           | Impact                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| **SMS / OTP provider**                         | Provider choice + Azerbaijani sender-ID registration                 | 🔴 **Blocks completing EPIC 2** — real sign-in      |
| Payment provider                               | Merchant / bank relationship; whether TezUsta may hold funds (legal) | Blocks EPIC 12                                      |
| Commission rate + guardrails                   | Business decision                                                    | Blocks EPIC 12                                      |
| Object storage provider                        | Cost and region preference                                           | [ADR-0005](../decisions/ADR-0005-object-storage.md) |
| Master verification criteria                   | Trust and policy decision                                            | Blocks EPIC 5 review flow                           |
| Cancellation rules                             | Business policy                                                      | Blocks EPIC 8                                       |
| Account recovery when the phone number is lost | Product decision — the principal weakness of phone-only sign-in      | Needed before launch                                |
| App icon, map style, illustration, motion      | Owner-supplied art                                                   | [ADR-0011](../decisions/ADR-0011-design-system.md)  |

**The SMS provider is now the highest-priority unblocking decision.** With OTP as
the only sign-in path, no user can enter the app without it.
