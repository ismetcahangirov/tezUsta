# ADR-0017 — Redux Toolkit for client state, RTK Query for server state

- **Status:** **Accepted**
- **Date:** 2026-09-15
- **Decided by:** Project owner
- **Supersedes:** the state-management rows of
  [`docs/architecture/technology-stack.md`](../architecture/technology-stack.md)
  as they stood before this ADR — TanStack Query for server state, Zustand for
  client state. No previous ADR recorded that choice, which is part of why it
  was easy to change.

## Context

The foundation scaffold shipped with **TanStack Query** owning server state and
**Zustand** owning client state. Both were documented in the technology stack
and wired into `apps/mobile`: one Zustand store holding the selected role, one
query client holding the transport policy.

The project owner has chosen **Redux Toolkit**, with **RTK Query** as the
data-fetching layer.

The decision is being taken at the last cheap moment. Today the migration is
two source files, their tests, two screens and a dependency swap, because no
business feature exists yet. After EPIC 6 every screen holds a query hook, and
the same change becomes a rewrite of the client.

## Decision

**`@reduxjs/toolkit` owns client state. RTK Query, which ships inside it, owns
server state. `react-redux` provides the binding.**

| Concern                                                            | Owner                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Orders, masters, services, statuses — anything the server decides  | RTK Query                                                             |
| Selected role, in-progress order draft, map camera, UI preferences | Redux slices                                                          |
| Auth tokens                                                        | `expo-secure-store`, with a thin slice for the derived signed-in flag |

Rules that come with it:

1. **The boundary is unchanged.** If the server is the source of truth, it does
   not belong in a slice. Copying a server value into client state creates two
   answers to one question, and the stale one always wins an argument at the
   worst moment. This rule survived the library change intact because it was
   never about the library.
2. **Endpoints are injected by the feature that owns them**, through
   `api.injectEndpoints`, never declared centrally. `src/api/api-slice.ts` is a
   transport policy, not a catalogue of every endpoint in the product — the
   same reason a NestJS module owns its own routes.
3. **Typed hooks only.** `useAppSelector` and `useAppDispatch` are exported
   from `src/store/hooks.ts`. Bare `useSelector` and `useDispatch` return
   loosely typed state, which is the `any` that `CLAUDE.md` §20 forbids arriving
   through the back door.
4. **`setupListeners` is not called.** Refetch-on-focus costs the user mobile
   data on every app switch, on a network they are paying for.
5. **No retry on any 4xx**, including `429`. This is carried over deliberately
   and is re-tested against the real base query, not assumed.

### What the removed query client did, and where it went

Nothing about the tuning was dropped in translation. RTK Query spells the same
ideas differently, and the mapping is written down here so that nobody later
"restores" a default that was chosen against:

| TanStack Query                | RTK Query                                    | Value                   |
| ----------------------------- | -------------------------------------------- | ----------------------- |
| `staleTime: 30_000`           | `refetchOnMountOrArgChange: 30`              | 30 seconds              |
| `gcTime: 5 * 60_000`          | `keepUnusedDataFor: 300`                     | 5 minutes               |
| `refetchOnWindowFocus: false` | `refetchOnFocus: false`, no `setupListeners` | off                     |
| `retry: shouldRetry`          | `retry(...)` + `retry.fail()` on 4xx         | 2 retries, never on 4xx |
| `mutations: { retry: 0 }`     | RTK Query never retries mutations            | off                     |

The 4xx rule is the one that does not survive on its own. RTK Query's `retry`
wrapper retries every failure up to the limit; `retry.fail()` is the only way
to say that a particular response is settled. If that call is ever removed, a
failed OTP verify starts spending the user's remaining attempts three times as
fast as the server's rate limit assumes.

## Why

**It is the owner's call, and the owner made it.** State management is a
product-team decision as much as a technical one: it shapes how every feature
is written and what a new contributor has to learn. `CLAUDE.md` §9 allows
technical architecture to be decided by research, but it does not oblige the
owner to accept the result.

On the merits there is a real argument for it here:

**One store, one devtool, one mental model.** The previous split meant two
libraries, two caches and two sets of conventions for "where does this value
live". Redux Toolkit answers both with the same primitives, and a single
Redux DevTools timeline shows a role switch and an order fetch in one place.

**RTK Query's cache is keyed by endpoint and argument, with tag invalidation.**
The order lifecycle is a graph of things that invalidate each other: accepting
an order changes the master's active job, the customer's order list and the
dispatch feed. Tag invalidation expresses that directly, rather than as a list
of query keys to remember to touch.

**Generated hooks remove a class of mistake.** `useGetOrderQuery` is generated
from the endpoint definition, so a screen cannot silently disagree with the
endpoint about its argument or result shape.

**Verified against the registry rather than recalled** (`CLAUDE.md` §9):
`@reduxjs/toolkit@2.12.0` declares peers `react ^16.9 || ^17 || ^18 || ^19` and
`react-redux ^7.2.1 || ^8.1.3 || ^9.0.0`, both optional;
`react-redux@9.3.0` declares `react ^18 || ^19`, `@types/react ^18.2.25 || ^19`
and `redux ^5.0.0`. This repository pins React 19.2.3 and `@types/react`
19.2.18, so both sit inside the declared ranges. `pnpm peers check` reports no
new unmet peer; the three it does report predate this change and concern Vite,
Expo modules and Metro.

## Alternatives considered

**Keep TanStack Query and Zustand.** The incumbent, and technically sound: the
split is lighter, Zustand has almost no ceremony, and TanStack Query's cache is
excellent. Rejected because the owner decided otherwise, and because the cost
of changing rises steeply from here.

**Redux Toolkit for client state, keep TanStack Query for server state.** A
common and defensible pairing. Rejected: it keeps two caches and two idioms,
and RTK Query is already in the dependency — paying for a second library to do
what the first one does is a cost with no return.

**RTK Query with a hand-written `fetch` wrapper instead of `fetchBaseQuery`.**
Rejected as premature. `fetchBaseQuery` covers base URL, headers, JSON parsing
and abort signals, and it accepts an injected `fetchFn`, which is the seam a
custom transport would need anyway.

## Trade-offs accepted

**More ceremony than Zustand.** A slice, a store, typed hooks and a provider
where Zustand needed one `create` call. For a two-field store that is a loss;
by EPIC 8 it will not be.

**RTK Query has no `staleTime`.** `refetchOnMountOrArgChange` is close but not
identical: it is evaluated at a mount or an argument change rather than
continuously. For this product's read patterns the difference is not
observable, but it is a difference, and the mapping table above exists so the
substitution is visible rather than silently assumed.

**A larger dependency.** Redux Toolkit pulls `immer`, `redux`, `redux-thunk`
and `reselect`. On a mid-range Android device this is measurable but small, and
it replaces two packages rather than adding to them.

**Jest needs two more packages transformed.** Redux Toolkit's CommonJS build
reaches for the `legacy-esm` files of `immer` and `react-redux`, so both had to
join the transform allow-list in `apps/mobile/jest.config.js`. Without them the
suite fails at import time, before a single test runs.

## Consequences

- `zustand` and `@tanstack/react-query` are removed from `apps/mobile` and from
  the lockfile.
- `src/stores/session.ts` becomes `src/store/session-slice.ts`, with
  `src/store/index.ts` and `src/store/hooks.ts` beside it. The directory is
  singular now because there is one store.
- `src/api/query-client.ts` becomes `src/api/api-slice.ts`.
- `app/_layout.tsx` mounts `<Provider store={store}>` in place of
  `QueryClientProvider`.
- Every document that named the previous libraries is corrected, and so is the
  one open issue that did.
- `EXPO_PUBLIC_API_URL` must be absolute. React Native has no page origin, so a
  relative base URL fails while the request is being built rather than at the
  transport — a confusing place to debug from.

## Revisit when

A second client application exists and needs the same server state. At that
point the api slice and the shared endpoint definitions are the first real
candidates for `packages/api-client`
([ADR-0016](ADR-0016-shared-package-timing.md)), and the extraction should be
its own commit.
