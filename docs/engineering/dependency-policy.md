# Dependency policy

Every dependency is code we did not write, ship to users, and must keep secure.
The default answer to "should we add this?" is **no**, until the case is made.

## Before adding a package

1. **Is it necessary?** Would twenty lines of our own code do it? A one-function
   dependency is rarely worth the supply-chain surface.
2. **Is it maintained?** Recent releases, issues triaged, more than one
   maintainer. An unmaintained package is a vulnerability with a delay.
3. **Is it compatible?** Check the **real** `peerDependencies` and `engines`
   against our pinned Node 24, pnpm 11, TypeScript 6, Expo 57, React Native 0.86
   (`engines` in the root `package.json` requires `node >=24.0.0` and
   `pnpm >=11.0.0`, matching `.nvmrc` and CI):

   ```bash
   curl -s https://registry.npmjs.org/<pkg>/<version> | jq '{peerDependencies, engines}'
   ```

4. **Security?** `pnpm audit`. Review the transitive tree, not just the package.
5. **Does something already in the tree do this?**
6. **What does it cost?** Bundle size matters on a mid-range Android device, and
   install/build time matters in CI.
7. **Is there an official alternative?** Prefer first-party Expo or Nest packages
   over third-party equivalents.

**Popularity is not a criterion.** Download counts measure adoption, not fitness
for this stack.

## A satisfied peer range is not evidence of support

This is the lesson from [ADR-0002](../decisions/ADR-0002-toolchain-version-pinning.md)
and it is the most important rule on this page.

`nativewind@4.2.6` declares `peerDependencies: { tailwindcss: ">3.3.0" }`.
Tailwind 4.3.3 satisfies it, so `pnpm install` succeeds — and the pairing is
unsupported, because NativeWind v4 targets the Tailwind 3 engine. The install
gives no warning.

**Check the documentation as well as the metadata.** A loosely-declared range
admits major versions the author never tested.

## When the docs and the package disagree, the package wins

Drizzle's documentation page implied PostGIS needed a custom type. Inspecting the
published tarball showed native `geometry()` support with SRID and GiST indexing
([ADR-0003](../decisions/ADR-0003-database-and-geo.md)).

```bash
npm pack <pkg>@<version> && tar xzf <pkg>-<version>.tgz   # then read it
```

Verify against the artifact when the answer matters.

## Version pinning

| Kind                                                              | Policy                                         |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| Tooling (TypeScript, ESLint, Prettier, turbo, dependency-cruiser) | **Exact.** No range.                           |
| Runtime dependencies                                              | Exact, upgraded deliberately                   |
| Expo-managed packages                                             | **`npx expo install`**, never `pnpm add`       |
| `react`, `react-native`                                           | Chosen **by the Expo SDK**, never set directly |

`npx expo install` consults Expo's compatibility service and installs the version
that matches the SDK. `pnpm add expo-location` installs `latest`, which may
belong to a different SDK.

## Currently pinned against upgrade

Do not "helpfully" upgrade these. Each has a documented reason
([ADR-0002](../decisions/ADR-0002-toolchain-version-pinning.md)):

| Package       | Pinned | Newest     | Gate                              |
| ------------- | ------ | ---------- | --------------------------------- |
| `typescript`  | 6.0.3  | 7.0.2      | `typescript-eslint` peer `<6.1.0` |
| `expo`        | 57.x   | 58 preview | 58 is not on `latest`             |
| `tailwindcss` | 3.4.17 | 4.3.3      | NativeWind v4 requires Tailwind 3 |
| `jest`        | 29.7.0 | 30.5.1     | `jest-expo@57` builds on Jest 29  |

Upgrading any of them requires re-running the compatibility check and writing an
ADR that supersedes ADR-0002.

### Rejected after a compatibility check

| Package                   | Why not                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@storybook/react-native` | Declares `react-native-safe-area-context` at **exactly `5.8.0`**; Expo SDK 57 pins `~5.7.0`. Also pulls `@gorhom/bottom-sheet` and `react-native-gesture-handler` for its own UI. [ADR-0012](../decisions/ADR-0012-component-workshop.md) |
| `clsx`                    | Replaced by six lines in `src/lib/cn.ts`. Every dependency ships to the device                                                                                                                                                            |
| `autoprefixer`            | Not needed: the only CSS consumer is Storybook, targeting current Chrome                                                                                                                                                                  |

### EPIC 2 (authentication) — checked 2026-09-16

Every candidate below was checked against live registry metadata
(`curl https://registry.npmjs.org/<pkg>`), not against recollection. Four
packages were considered and none was added; re-run the check before adopting
any of them, rather than assuming the situation is unchanged.

| Package                                                   | Verdict      | Evidence                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/throttler` + `@nest-lab/throttler-storage-redis` | **Rejected** | Hard peer conflict, not a loose range: **no** published `@nestjs/throttler` (through `6.5.0`, the current `latest`) declares `@nestjs/core` above `^11.0.0`, and this repository pins `12.0.1`. The Redis storage adapter is a thin wrapper on it and inherits the same ceiling.  |
| `@nestjs/jwt`                                             | **Rejected** | `12.0.2` peers cleanly against Nest 12, but wraps `jsonwebtoken@9.0.3`, which pulls nine further packages (`jws`, `ms`, `semver`, six `lodash.*` micro-packages) to support an algorithm matrix this project never uses.                                                          |
| `jose`                                                    | **Deferred** | `6.2.12`, zero runtime dependencies, and empirically verified to load from this repository's CommonJS build through Node 24's `require(esm)`. The right escalation the day TezUsta needs asymmetric signing or a JWKS — neither is in scope for HS256 with one secret.            |
| `argon2` / `bcrypt` / `scrypt` for OTP codes              | **Rejected** | A slow KDF cannot rescue a ~20-bit keyspace, and OWASP's MFA guidance says so directly. The control that actually closes the database-dump path is a **keyed** digest — HMAC-SHA256 under a config-held pepper — which `node:crypto` already provides at no per-request CPU cost. |
| `libphonenumber-js`                                       | **Deferred** | `1.13.13`, MIT, dual CJS/ESM, actively maintained — no compatibility problem. Its value is multi-country parsing, and TezUsta launches `+994`-only. Revisit under ADR-0016 when `apps/mobile` needs the same validation and the logic moves to `packages/validation`.             |

What was written instead, and why each is genuinely "a few lines of our own
code" rather than a dependency avoided on principle:

- `apps/api/src/common/crypto/hs256-jwt.ts` — one algorithm, one secret. The
  header is a compile-time constant that verification **compares** rather than
  parses, so `alg: none` and algorithm-confusion are shapes the code cannot
  express, instead of defaults someone has to remember to override.
- `apps/api/src/common/ids/uuid-v7.ts` — RFC 9562 §5.7 is six lines over
  `randomBytes`. PostgreSQL 17 cannot supply it either: `gen_random_uuid()` is
  v4 and `uuidv7()` arrives in 18.
- `apps/api/src/common/time/parse-duration.ts` — the accepted grammar is already
  pinned by a regular expression in `env.schema.ts`. The `ms` package accepts a
  much looser grammar, and adopting it would silently widen what counts as a
  valid TTL.

Refresh tokens are hashed with plain-strength HMAC-SHA256 rather than a slow
KDF, which **NIST SP 800-63B §5.1.2.2** permits explicitly: the 112-bit
threshold at which a salted KDF becomes mandatory is for secrets _below_ it, and
a 256-bit CSPRNG token is far above. No KDF makes an unguessable value more
unguessable.

## Notable additions

### `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` — 3.1134.0 (issue #38)

Both pinned exactly, both Apache-2.0, both `engines.node >= 20` against this
repository's Node 24 pin. Verified against the registry rather than from memory
(CLAUDE.md §9): `curl https://registry.npmjs.org/@aws-sdk/client-s3`.

**The §10 question — "is it necessary, or is this a few lines of our own code?"
— was taken seriously and answered no.** The alternative was a hand-rolled
SigV4 query-string presigner over `node:crypto`, around a hundred lines. SigV4
has canonicalisation edge cases (URI-encoding of the canonical query string,
header casing, the `UNSIGNED-PAYLOAD` body-hash placeholder, clock-skew
tolerance) that a small implementation gets subtly wrong in ways that surface
as an intermittent `SignatureDoesNotMatch` against one provider's quirks. This
signs access to the bucket holding every master's identity documents; the
reference implementation is worth 27 packages.

`minio` was the other candidate and was rejected: its `PostPolicy` API is
functionally equivalent for what this needs, it pulls a more eclectic
dependency set, and its release cadence is months against the AWS SDK's days.
ADR-0005 also forbids a provider-specific SDK while the provider stays
reversible, and the AWS SDK targets the S3 **protocol** rather than an AWS
account — it is what talks to Cloudflare R2 (ADR-0024).

**Pinned at 3.1134.0 rather than `latest`.** This line publishes daily, and
3.1135.0 was under 24 hours old at the time of the review — inside pnpm 11's
publication-age floor, so pinning it would have meant an exclude-list entry for
nothing. 3.1134.0 is the same functionality and clears the floor on its own.

### `bullmq` — 6.3.7 and `@nestjs/bullmq` — 12.0.0 (issue #102)

Both pinned exactly, both MIT, and the full reasoning is
[ADR-0025](../decisions/ADR-0025-deferred-work-on-bullmq.md). Registry
metadata, checked rather than recalled: `bullmq@6.3.7` declares
`engines.node >= 14.17.0` and four **optional** peers (`pg >=8.0.0`,
`redis >=5.0.0`, `ioredis >=5.0.0`, `bullmq-otel >=2.0.0`);
`@nestjs/bullmq@12.0.0` names `@nestjs/core` and `@nestjs/common`
`^10 || ^11 || ^12` and `bullmq` `^3 || ^4 || ^5 || ^6`. Against this
repository's node 24, `ioredis@6.0.0`, `pg@8.23.0` and `@nestjs/*@12.0.1`,
every range is satisfied by a named major rather than by a range that happens
to admit it.

**The §10 question was answered no.** A hand-built Postgres queue
(`FOR UPDATE SKIP LOCKED`) is genuinely correct and was the serious
alternative; it is rejected on count of mechanisms, because
[`backend-architecture.md`](../architecture/backend-architecture.md) has
already committed four more queues to BullMQ for EPIC 8/10/12. See ADR-0025's
alternatives table.

**Pinned at 6.3.7 rather than 6.3.8**, which was seventeen hours old at the
time of the review — inside pnpm 11's publication-age floor. 6.3.7 has
byte-identical `engines` and `peerDependencies` and clears the floor on its
own, so **no exclude-list entry was added**. That is the rule below applied in
the direction it is usually applied in reverse: take the older patch, do not
exempt the newer one.

`msgpackr-extract`, the optional native accelerator BullMQ's `msgpackr`
dependency can use, is declined in `pnpm-workspace.yaml`'s `allowBuilds`.
`msgpackr` falls back to its pure-JS path — documented behaviour, not a
degraded mode — and declining it keeps a node-gyp compile out of every
install for a queue whose payloads are a UUID and two integers.

### `expo-image-picker` — 57.0.19 (issue #85)

An official Expo module, MIT, versioned in lockstep with the SDK: the `57.x`
line _is_ the SDK 57 build, against this repository's `expo@57.0.22` pin. Its
peer range is `expo: *`, which is the loose kind CLAUDE.md §3 warns about — so
the evidence for compatibility is the version line, not the peer range.
Verified against the registry rather than from memory (CLAUDE.md §9):
`curl https://registry.npmjs.org/expo-image-picker`.

**The §10 question was taken seriously and the answer is that there is no
alternative worth having.** Choosing a photo means talking to the platform's
photo library and its permission prompt — `PHPickerViewController` on iOS, the
Storage Access Framework on Android — through native code. That is not a few
lines of our own; it is a native module either way, and writing one would mean
maintaining two platform implementations plus their permission edge cases for a
capability the SDK already ships and tests.

The bytes it returns never reach the API: the file is `PUT` straight to object
storage through a presigned URL, and the server is told only the photo id
(ADR-0005). So this dependency's blast radius is the picker itself.

Added to `minimumReleaseAgeExclude` by pnpm at install time.

### `expo-notifications` — 57.0.20, and `expo-constants` 57.0.18 → 57.0.19 (issue #145)

An official Expo module, MIT, versioned in lockstep with the SDK. Its peer
range is `{ expo: "*", react: "*", react-native: "*" }` — worthless as
evidence, exactly the trap CLAUDE.md §3 describes. **The evidence is
`expo@57.0.22`'s own `bundledNativeModules.json`, which pins
`"expo-notifications": "~57.0.18"`, plus the registry's `sdk-57` dist-tag
resolving to `57.0.20`.** `npx expo install --check` reports it as compatible.

**The `expo-constants` bump is forced, not opportunistic.**
`expo-notifications@57.0.20` depends on `expo-constants@~57.0.19` and this
repository pinned `57.0.18` exactly. Left alone, pnpm installs a second nested
copy of a native module, which Expo autolinking does not resolve well and which
no dependency-cruiser rule would catch — both copies are declared somewhere.
`57.0.19` is inside the SDK's own `~57.0.18` range, so nothing else moves.

`expo-application@~57.0.3` arrives transitively. It is an SDK 57 module and is
not imported by our code; anything that wanted it would have to declare it,
which `no-non-package-json` enforces.

**Is it necessary?** Push delivery is a native capability on both platforms —
an APNs registration and an FCM token, plus Android's channel and runtime
permission model. It is not a few lines of our own, and the alternative
(`@react-native-firebase/messaging`) means abandoning the Expo push service the
API already sends through (`apps/api/src/infra/push/`), handling FCM _and_ APNs
rotation ourselves, and adding a prebuild-hostile native dependency to an app
that is otherwise config-plugin only.

**One shipped behaviour worth recording, because it is not in the docs.**
Importing `expo-notifications` registers a device-token listener at module
scope, and that listener _throws_ in Expo Go on Android from SDK 55. The
adapter therefore `require`s the module on first use behind a support guard
rather than importing it — see `apps/mobile/src/notifications/push-adapter.ts`.
Read out of the package, not from a documentation page (§9: the artifact wins).

Neither version needed a `minimumReleaseAgeExclude` entry: both were published
2026-09-18, four days before they were installed.

### `react-native-maps` — 1.27.2 (issue #172)

The customer's tracking map
([ADR-0035](../decisions/ADR-0035-customer-tracking-map.md)). The library itself
was decided in [ADR-0004](../decisions/ADR-0004-location-and-maps.md); what was
checked here is the version.

- **Which version.** `latest` is `1.29.8`; ADR-0004 had written down `1.29.2`
  while the package was only planned. Installed with `npx expo install`, which
  chose **`1.27.2`** — the version `expo@57.0.22`'s own
  `bundledNativeModules.json` names for SDK 57 — and pinned exact like every
  other native module here. A newer native module than the SDK was tested with
  is exactly the "satisfied peer range is not evidence of support" trap this
  file opens with. ADR-0035 supersedes ADR-0004's version number, nothing else.
- **Peers and engines** (`curl https://registry.npmjs.org/react-native-maps/1.27.2`):
  `react >= 18.3.1`, `react-native >= 0.76.0`, optional
  `react-native-web >= 0.11`; `engines.node >= 20.19.4`. Satisfied by React
  19.2.3, React Native 0.86.3, React Native Web 0.21.2 and Node 24. One
  dependency, `@types/geojson`. MIT. `pnpm audit --prod` reports nothing for it.
- **Read out of the package, not the docs** (§9). The config plugin
  (`plugin/build/ios.js`, `android.js`) writes `GMSApiKey` / the
  `com.google.android.geo.API_KEY` manifest entry and installs the Google Maps
  SDK pod on iOS **only when an iOS key is given** — which is why the adapter
  falls back to the platform provider on iOS without one. `animateMarkerToCoordinate`
  exists only in the Apple Maps implementation on iOS (`ios/AirMaps`), which is
  why the marker is interpolated in JavaScript. `fitToCoordinates`' edge padding
  reaches `GoogleMap.setPadding` as raw pixels on Android, which is why the
  adapter converts it. `MapView.web.ts` is React Native Web's
  `UnimplementedView`, which is why `map-surface.web.tsx` exists.
- **The §10 question.** Drawing a Google map is the Google Maps SDK on each
  platform through native code; there is no twenty-line version. The cost is
  real — the Google Maps SDK is the largest native payload the app has added —
  and is paid only by the one screen that mounts a map, only while a position
  exists (ADR-0035 § 3). Its frame-rate cost on a mid-range Android has **not**
  been measured; #173 owns that.
- **Keys.** Read from `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY` /
  `EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY` at build time — the one documented
  `EXPO_PUBLIC_` exception (`security.md`). Verified with
  `npx expo config --type introspect`: with an Android key set, the manifest
  carries it; with none, the entry is removed.

Published 2026-03-11, so no `minimumReleaseAgeExclude` entry was needed.

### `livekit-server-sdk` — 2.19.1 (issue #184)

The server half of in-app calling
([ADR-0034](../decisions/ADR-0034-in-app-voice-calls.md)): it signs join
tokens, calls LiveKit's RoomService and verifies its webhooks. Pinned by this
policy on its own terms rather than by #183's device spike —
[ADR-0038](../decisions/ADR-0038-server-calling-ahead-of-the-mobile-spike.md)
records why the mobile SDK's risk does not reach it.

- **Which version.** `latest` is `2.19.1`, published 2026-09-20 — four days
  before the review, so it clears pnpm's 24-hour floor and needs no
  `minimumReleaseAgeExclude` entry.
- **Peers and engines** (`curl https://registry.npmjs.org/livekit-server-sdk/2.19.1`):
  no peers; `engines.node >= 19` against Node 24; Apache-2.0. Three
  dependencies — `jose ^5.1.2` (resolves 5.10.0, MIT), `@livekit/protocol`
  exact `1.51.0` (Apache-2.0) and `@bufbuild/protobuf ^1.10.1` — and none was
  in the tree before. `pnpm audit --prod` reports nothing for any of them.
- **ESM in a CommonJS build — read out of the package, not assumed.** The
  package is `"type": "module"`, which reads like a problem for an API that
  `nest build` compiles to CommonJS. It is not one: its `exports` map carries
  a `require` condition pointing at a real CJS build (`dist/index.cjs`, with
  `index.d.cts` types), so TypeScript under `moduleResolution: nodenext`
  resolves the CJS declarations, `dist/` `require`s the CJS file, and Vitest
  imports the ESM one. Verified by building and `require`-ing
  `dist/infra/calls/livekit-call-media.provider.js` against the local LiveKit
  (`require.resolve` → `…/dist/index.cjs`), and by booting `node dist/main.js`
  with `CALLS_PROVIDER=livekit`. No `require(esm)` and no dynamic `import()`
  were needed.
- **The §10 question.** A join token is an HS256 JWT and could be signed with
  `node:crypto` in a few lines. RoomService is Twirp over protobuf-JSON, with
  per-call admin tokens whose grants differ by method, and the webhook scheme
  is a JWT carrying a SHA-256 of the body. Hand-rolling all three is a second,
  untested implementation of LiveKit's own client, for a server this project
  also runs; the official SDK is the reference.
- **Behaviour worth knowing, from the shipped `dist/`.** `AccessToken` falls
  back to `process.env.LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` when a value is
  falsy — the adapter always passes both, and the schema never lets either be
  empty. `RoomServiceClient` fails over between regions on a transport error
  (a LiveKit Cloud feature), which the adapter turns off so a dead server
  fails fast. `TokenVerifier` requires `exp` and allows ten seconds of clock
  skew.
- **Scope.** Imported only in `apps/api/src/infra/calls/`; no LiveKit type
  crosses that folder. Nothing from `@livekit/*` enters `apps/mobile` until
  #183 reports (ADR-0038).

## Upgrading

- Upgrade **one significant dependency per PR**. A failure in a batched upgrade
  cannot be attributed.
- Read the changelog, not just the version number.
- Run `pnpm verify` and exercise the affected area.
- Major versions get their own PR and a real review.
- Security patches take priority and can move faster — but still verified.

## Removing

When a feature is removed, remove its dependencies. Orphaned packages are
maintenance and attack surface for nothing.

```bash
node tools/project-graph/query.mjs <file>   # confirm nothing still imports it
pnpm why <package>                          # confirm nothing depends on it
```

## Forbidden

- Adding a package to avoid writing a simple function
- Adding a package without checking its peers against our pins
- Installing `latest` for an Expo-managed package
- Committing a lockfile change that was not reviewed
- Adding a dependency with a known unpatched critical advisory
- Upgrading a pinned package without a superseding ADR

## Lockfile

`pnpm-lock.yaml` is committed and reviewed. A change to it in a PR that did not
intend a dependency change is a red flag worth asking about.

CI installs with a frozen lockfile, so a dependency cannot drift between local
and CI.

## The publication-age floor

pnpm 11 applies a built-in `minimumReleaseAge` of **24 hours** even when
`pnpm-workspace.yaml` sets none: a version published inside that window is
rejected, including from an already-committed lockfile. It is a supply-chain
control — the window in which a compromised release is most likely to be found
and unpublished is the window in which we refuse to install it.

`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` is the exemption list, and it
is **load-bearing, not decoration**. Every entry is a version this repository
pinned deliberately after a compatibility review, at a point when it was newer
than the floor. Removing an entry makes `pnpm install --frozen-lockfile` fail
until that version ages out — verified by removing one.

So:

- Pinning a just-published version means adding it to the exclude list **in the
  same commit**, with the reason it was pinned that new.
- Do not tidy the list. An entry that looks redundant is a failed CI install for
  whoever next runs a clean install on an older lockfile.
- Do not raise `minimumReleaseAge` above the default either: Expo's metro
  packages publish continuously, and a 72-hour floor rejects the committed
  lockfile outright.

## Notable additions

| Package             | Version | Why, and what was checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.io-client`  | 4.8.3   | The client half of the realtime transport (#170), pinned to the **same** version as the server's `socket.io` so the protocol cannot drift. No peer constraints. `engine.io-client`'s `browser` field maps its `*.node.js` transports onto the browser ones, and `metro-resolver`'s `redirectModulePath` applies exactly those replacements under Expo's `resolverMainFields`, so `ws` and `xmlhttprequest-ssl` never reach the app bundle.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `expo-location`     | 57.0.19 | The master's position reporter (#171). Installed with `npx expo install`, so the version is the one Expo's compatibility service names for SDK 57, then pinned exact to match every other `expo-*` entry. Background enabled with #171's accept surface: `ACCESS_BACKGROUND_LOCATION`, the location foreground service and iOS `UIBackgroundModes: location`, all checked in the introspected native config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `expo-task-manager` | 57.0.19 | Runs the background location session (#171): `startLocationUpdatesAsync` delivers to a task defined with it. `57.0.19` is the `sdk-57` dist-tag and inside Expo 57's bundled range (`~57.0.17`, `expo/bundledNativeModules.json`); peers `expo: *` and `react-native: *`; MIT; its one dependency is `unimodules-app-loader`. Pinned exact like every other `expo-*` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `expo-audio`        | 57.0.5  | The microphone permission prompt for in-app calls (#187, [ADR-0039](../decisions/ADR-0039-call-surfaces-and-ring-push-ahead-of-the-spike.md) § 2), and nothing else yet — recording and playback belong to the room bridge. `57.0.5` is both `latest` and the `sdk-57` dist-tag, inside Expo 57's bundled range (`~57.0.5`, `expo/bundledNativeModules.json`); MIT; no dependencies; peers `expo`, `expo-asset`, `react`, `react-native`, all `*`, and `expo-asset@57.0.17` is already in the tree through `expo`. Published 2026-09-11, so no `minimumReleaseAgeExclude` entry. Its config plugin defaults `enableBackgroundPlayback` to **true**, which would add `UIBackgroundModes: audio` and a media-playback foreground service; `app.config.js` sets both background options to `false`, checked in the introspected native config. Imported by `src/calls/microphone-adapter.ts` only. |

Both were checked against the registry and the shipped package rather than
against documentation, per the rule this file opens with.
