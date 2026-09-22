# Mobile architecture

Expo SDK 57, React Native 0.86, React 19.2.3, Expo Router, NativeWind 4.
Versions and reasoning: [`technology-stack.md`](technology-stack.md).

> **No visual design is specified here.** Layout, colour, typography, spacing,
> and component appearance are owned by the project owner (CLAUDE.md §17). This
> document covers structure only, and is written so the visual layer stays
> configurable.

## One app, two roles

Customer and master ship in a single binary with the experience switched by
role. Rationale: [`../product/user-roles.md`](../product/user-roles.md).

```
apps/mobile/
├── app/                        # Expo Router — file-based routes
│   ├── _layout.tsx             # providers + session restore + route guard
│   ├── index.tsx               # entry — redirects on the session, nothing else
│   ├── (auth)/                 # unauthenticated — sign-in, OTP verify
│   ├── (customer)/             # customer role group
│   ├── (master)/               # master role group
│   └── (shared)/               # profile, settings
├── src/
│   ├── api/                    # base-query.ts (transport policy), api-slice.ts
│   ├── auth/                   # tokens, refresh, route guard (issue #30)
│   ├── components/             # reusable components (+ co-located tests + stories)
│   ├── notifications/          # push: permission, device registration, channels
│   ├── store/                  # index.ts, hooks.ts, session-slice.ts
│   ├── lib/                    # secure storage, class-name helper
│   └── theme/                  # design tokens, useTheme()
└── assets/
```

**What is not there yet.** `src/features/` does not exist — feature modules
(orders, matching, tracking) are the intended home for screen-level logic and
arrive with their Epics. Authentication is **not** one of them and lives in
`src/auth/`: it wraps the transport every other feature uses, so it is
infrastructure rather than a screen module. Theme is read through a `useTheme()`
hook rather than supplied by a context, and there is still no auth _provider_ —
the root layout runs two hooks (`useRestoreSession`, `useAuthGuard`) inside the
Redux `<Provider>` and nothing else.

### Authentication on the client

| Piece                      | Lives in                        | Does                                                                               |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `tokenStore`               | `src/auth/token-store.ts`       | Refresh token in `expo-secure-store`; access token in module memory, never on disk |
| `createRefreshCoordinator` | `src/auth/refresh.ts`           | Trades the refresh token for a new pair — **one at a time**                        |
| `createAuthBaseQuery`      | `src/auth/auth-base-query.ts`   | Attaches the bearer token; refreshes and replays a 401 under the caller            |
| `authApi`                  | `src/auth/auth-endpoints.ts`    | OTP request/verify, sign-out, sign-out-everywhere                                  |
| `resolveAuthRedirect`      | `src/auth/route-guard.ts`       | Where a session says the user belongs — a pure function                            |
| `useAuthGuard`             | `src/auth/useAuthGuard.ts`      | Applies that answer with `router.replace`, from the root layout                    |
| `useRestoreSession`        | `src/auth/useRestoreSession.ts` | Turns the stored refresh token into a session at launch                            |
| `useSignOut`               | `src/auth/useSignOut.ts`        | Retires this device from the push registry, **then** revokes the session           |

**Sign-out has an order, and it is not merely "before the tokens are cleared".**
`apps/api/src/modules/auth/actor.service.ts` re-reads the session on every
request, so the moment `POST /auth/logout` lands, a `DELETE /devices/:id`
racing alongside it is unauthenticated. `useSignOut` sequences the two; doing
it inside the mutation's `onQueryStarted` could not, because that runs after
its own request has already gone out.

**Concurrent 401s must produce one refresh, not five.** Every refresh rotates,
and presenting a spent refresh token is read by the server as a stolen
credential being replayed — which revokes the whole session family
([`authentication.md`](authentication.md) § Refresh rotation with reuse
detection). A screen firing five requests against one expired access token
would therefore sign the user out of every device they own. The coordinator
shares a single in-flight promise so that cannot happen, and the base query
additionally skips the refresh entirely when it notices the access token
changed under it.

`src/api/base-query.ts` holds the retry policy and `src/api/api-slice.ts`
composes it with the auth layer. They are two files rather than one because
`api-slice` imports the auth base query, and the auth base query imports the
retry policy: keeping the policy in `api-slice` would close a cycle, and
`no-circular` is a CI-failing rule (CLAUDE.md §14).

### The route groups are not a guard

Route groups keep the role trees separate, which is an organisational and UX
affordance and **nothing more**. `useAuthGuard` now redirects a signed-out user
to `(auth)` and keeps a customer out of `(master)`, and none of that is
security.

**The router is never where authorization happens.** Every request is
authorized server-side, per request, against current database state
([`authentication.md`](authentication.md); CLAUDE.md §11, §20). A client-side
role check is a hint about what to render, and a reader must not infer from the
existence of a guard that anything is protected by it — it only makes the app
tidier. The guard that matters is the one the client cannot reach.

The grants the guard reads come from the access token's `roles` claim, decoded
without verifying the signature because the client holds no key. That is
acceptable for the same reason: a forged claim would change which tab is drawn
and nothing else, because the server re-reads `user_roles` on every request.

## State management

**RTK Query owns server state. Redux slices own client state. The boundary is
not negotiable.** The libraries are recorded in
[ADR-0017](../decisions/ADR-0017-state-management.md); the boundary predates
them and is what actually matters.

| State                               | Owner                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Orders, masters, services, statuses | RTK Query                                                                                                                      |
| Auth session (tokens)               | Secure storage + `src/auth/token-store.ts`; the session _flag_, the granted roles and the selected role are in `session-slice` |
| Selected role (customer/master)     | A Redux slice                                                                                                                  |
| In-progress order draft             | A Redux slice                                                                                                                  |
| Map camera, UI preferences          | A Redux slice                                                                                                                  |

**Rule: if the server is the source of truth, it does not belong in a slice**
(CLAUDE.md). Copying server data into the store means re-implementing caching,
invalidation, retry, and staleness by hand — and getting it wrong.

### RTK Query conventions

- **Endpoints are injected by the feature that owns them**, through
  `api.injectEndpoints`. `src/api/api-slice.ts` is a transport policy, not a
  catalogue of every endpoint in the product — the same reason a NestJS module
  owns its own routes.
- **Use the generated hooks** (`useGetOrderQuery`, `useAcceptOrderMutation`).
  They are derived from the endpoint definition, so a screen cannot silently
  disagree with it about argument or result shape.
- **Typed hooks only** for the store itself: `useAppSelector` and
  `useAppDispatch` from `src/store/hooks.ts`. Bare `useSelector` and
  `useDispatch` return loosely typed state, which is the `any` CLAUDE.md §20
  forbids arriving by the back door.
- Cache invalidation is expressed with **tags**, not with keys a caller has to
  remember to touch. Mutations `invalidatesTags`; optimistic patching through
  `api.util.updateQueryData` is reserved for where it is genuinely warranted
  (accepting an order).
- Realtime events invalidate or patch that same cache — **the socket does not
  become a second store**. One cache, one source of truth.
- **`setupListeners` is deliberately not called**, and `refetchOnFocus` is off.
  Refetch-on-focus costs the user mobile data on every app switch.
- Freshness is tuned on the api slice: `refetchOnMountOrArgChange: 30` (30
  seconds) and `keepUnusedDataFor: 300` (5 minutes). Per-endpoint overrides are
  the way to say that a resource is more or less volatile than that — the
  service catalogue is stable for minutes, an active order is not.
- **No `useEffect` + `fetch`.** That pattern has no dedup, no retry, no cache,
  and races on unmount.

## Data fetching and offline behaviour

Mobile networks in this market are unreliable. This is a normal condition, not an
edge case.

- Retry with exponential backoff, **never on a 4xx** — `src/api/base-query.ts`
  wraps the base query in RTK Query's `retry` and calls `retry.fail()` the
  moment a response carries a 4xx status. `retry` on its own retries every
  failure up to the limit, so `retry.fail()` is the only way to say that a
  particular response is settled; removing that call silently removes the rule.
  A 4xx is the server stating that this request, as sent, is wrong; sending it
  again cannot change the answer. Two statuses make retrying
  actively harmful: **`429` is an instruction to stop**, so retrying burns the
  caller's remaining budget — on OTP verify, three times faster than the server
  policy assumes ([`authentication.md`](authentication.md) § Rate limiting) —
  and `401` triggers a refresh-and-replay cycle in `src/auth/auth-base-query.ts`
  that a retry underneath would multiply. A failure with **no readable status** is treated as
  a network failure and retried, which is the common case on a mobile network.
- Mutations do not retry at all — RTK Query never retries them. A retried
  mutation is a duplicate unless the idempotency key below is in place, so the
  safe default is zero.
- **Mutations carry an idempotency key.** A retried order creation must not
  create two orders.
- Show real state: loading, empty, and error are distinct. An indefinite spinner
  is a bug.
- Cached data may be shown stale with an indication, rather than showing nothing.

### "Offline" is what a request did, not what the radio says

`isTransportFailure` in `src/api/base-query.ts` is the whole of it: a
`FetchBaseQueryError` whose `status` is a string (`FETCH_ERROR`,
`TIMEOUT_ERROR`) rather than a number is a request that never got an answer.
That is the same signal the retry policy already keys off.

Deliberately **not** `@react-native-community/netinfo`. A connectivity flag is
a second source of truth that can disagree with what a request actually did —
a captive portal reports "connected" and answers nothing — and it costs a
native dependency to be less accurate. The honest claim is "this request did
not get through", and that is the claim the screen makes.

A screen shows stale content plus a `Banner` when the request failed **and**
there is already data to show; it shows an `EmptyState` with a retry only when
there is nothing. `ServiceCatalogue` (issue #33) is the reference
implementation of all four states.

### A signed-in phone is not yet a customer

`(customer)` renders behind `CustomerProfileGate` (issue #94). Sign-in proves a
number and nothing else, so a brand-new account has no `customers` row and every
customer-scoped endpoint answers 404 until one exists. The gate reads
`GET /customers/me`, asks one question when the answer is 404, and renders the
group once a profile is there
([ADR-0028](../decisions/ADR-0028-customer-profile-at-first-run.md)).

**The distinction that matters is in `customer-profile-state.ts`, not in the
component.** A 404 is an answer — "you have no profile" — and a 500, a timeout
or a request that never left the phone is not. They are separated by a pure
function with its own tests, because conflating them would ask an established
customer to introduce themselves whenever the network dropped, and then post a
profile they already had. It is the same rule the section above states about
what "offline" means, applied to a status code that happens to look like an
error and is not one.

It **renders instead of redirecting**, and it is mounted in the customer
group's own layout rather than the root: a master never meets it, structurally
rather than by a condition somebody has to remember. `route-guard.ts` still
decides which group a user belongs in; this decides what that group can show
once they are in it.

### The service catalogue holds no catalogue

`src/service-catalogue/` renders whatever the API returns and names no category
and no service anywhere — `no-hardcoded-catalogue.test.ts` scans the shipped
source and fails if one appears. Adding a service is a database row and reaches
the customer on the next fetch, with no release (EPIC 3).

Its response types come from `@tezusta/types`, the same file `apps/api` serves
them from, so a contract change is a compile error on both sides rather than a
runtime surprise on one.

Prices arrive as integer minor units plus a currency code and are formatted by
`Intl.NumberFormat` — Hermes ships with Intl enabled on both platforms in
`react-native@0.86.3`, verified in the build configuration rather than assumed.
**`Intl.NumberFormat.prototype.formatToParts` must never be used**: Hermes
implements it as `llvm_unreachable` on Apple, which aborts the process rather
than throwing, so nothing catches it.

## Components

```
src/components/
  Button.tsx
  Button.test.tsx
  Button.stories.tsx
  index.ts            # one barrel for the set
```

- Co-located tests, always (CLAUDE.md §13), and a co-located story for anything
  with a visual state worth reviewing
  ([ADR-0012](../decisions/ADR-0012-component-workshop.md)).
- Presentational components take props and hold no server state.
- Feature components may use query hooks.
- **No design tokens hardcoded in a component.** Colour, spacing, and type come
  from `src/theme`, which the owner populates. A hex value in a component is a
  decision engineering was not entitled to make.

## Performance

The realistic device here is mid-range Android, not a flagship.

| Concern       | Rule                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Lists         | `FlatList`/`FlashList` with stable `keyExtractor`. Never `.map()` over a long list.            |
| Re-renders    | Memoise expensive children; keep frequently-changing values out of shared context              |
| Live location | Interpolate the marker between updates instead of raising update frequency                     |
| Images        | Size and cache them; never render a full-resolution upload in a list                           |
| Bundle        | Watch dependency weight — every package ships to the device ([CLAUDE.md §10](../../CLAUDE.md)) |
| Maps          | One map instance per screen; release it on unmount                                             |

The marker-interpolation point matters: smoother tracking is a rendering
problem, not a reason to spend battery and bandwidth on more GPS updates
([`realtime-architecture.md`](realtime-architecture.md)).

## Permissions

Location permission is the app's highest-friction moment.

- Request **at the point of need**, with a plain explanation — never at first
  launch, where it gets denied by reflex.
- Background location is requested **only** when an order is accepted, and stops
  when the order ends.
- Every denial has a working path forward (manual address entry). A denied
  permission must not dead-end the flow.
- Re-entering from settings must be handled without an app restart.

### Notification permission is asked from two call sites, and nowhere else

`src/notifications/` (issue #145) applies the same rule. The app registers this
phone with `POST /devices` at every launch that has a session, but it registers
**silently**: `usePushRegistration` passes `mayAsk: false`, so a phone that has
already agreed is registered and one that has not is left alone.

The dialog comes from `usePushAccessPrompt`, and it is called in exactly two
places — after a customer creates an order, and after a master goes online.
Both are moments where the answer is obviously yes, because the user is now
waiting to hear something. Asking earlier spends the question on somebody with
no reason to agree, and **on iOS the system prompt is shown once**, so a reflex
refusal is permanent. The trigger being one function is what makes moving it a
two-line change rather than an archaeology exercise — where it belongs is an
onboarding decision and onboarding is the owner's (CLAUDE.md §17).

Three platform facts shape the rest of that module, all read out of the shipped
`expo-notifications@57.0.20` rather than taken from documentation:

- **Channels are created before the token is requested.** On Android 13 the
  system permission prompt does not appear until a channel exists.
- **iOS permission is read from `ios.status`, not from `granted`.** A
  provisionally authorised app delivers notifications and reports
  `granted: false`.
- **`expo-notifications` is `require`d on first use, never imported.** The
  module installs a device-token listener at import, and that listener throws
  in Expo Go on Android — a static import would take down a development surface
  that has nothing to do with push.

Push does not deliver at all until an EAS project id and FCM credentials exist;
until then the token call fails and the app carries on, which is
`token-unavailable` rather than an error anybody sees.

### A tapped notification is routed, never followed

`useNotificationRouting` (issue #146) sits beside `useAuthGuard` in the root
layout, because a cold-start tap arrives before any screen has mounted.

**One subscription covers both entry paths.** A tap from the background arrives
through the response listener; a tap that cold-started the app is already
waiting in `getLastNotificationResponse()` before a listener could have
attached. `subscribeToNotificationTaps` reads the stored one and then
subscribes, so there is one code path rather than two that drift — and the
cold-start one is the one nobody opens the app cold enough to notice.

**The payload names a kind, never a screen.** `readNotificationTarget` maps
`kind` + `orderId` through a closed table and drops everything else, so a `url`
or `path` in the payload is not carried anywhere that could act on it. An
unknown kind does not navigate at all (see
[`../engineering/security.md`](../engineering/security.md) § A notification
payload is input too).

**The difficult part is waiting, not routing.** The target is held until the
navigator exists (`useRootNavigationState()` is `undefined` before the root
layout mounts) _and_ the session has settled — `restoring` is "not known yet",
not "signed out". A signed-out tap needs no special case: the target stays held
while the guard takes the user to sign-in, and the same effect releases it when
the session becomes `signed-in`. Surviving the sign-in is a property of holding
it, not a feature beside it.

**Which role, and the placeholder that is honest about itself.** The kind names
an audience where it can — only masters are offered work, only the customer
hears that a master accepted — and `'either'` where it cannot, because the
server notifies everyone on the order except whoever acted, so
`order-cancelled` reaches a master when the customer cancelled. A dual-role
user is switched into the role the notification is about; a role the account
does not hold is refused rather than corrected.

**The route is the role home, and that is temporary.** Nothing in `apps/mobile`
renders an order yet — no order detail screen, no master offer feed — so there
is no screen for `orderId` to open. `resolveNotificationRoute` is the one place
that changes when one exists, and `NotificationTarget` already carries the id
it will need.

## Security on the client

- Tokens in `expo-secure-store`. **Never `AsyncStorage`** (CLAUDE.md §20).
- **Nothing secret behind `EXPO_PUBLIC_`** — that prefix embeds the value in the
  shipped bundle, readable by anyone who unzips the APK. A value is secret if it
  grants server authority or billing power. The one documented exception is a
  platform-restricted client map key, protected by its bundle-id restriction
  rather than by secrecy; the billable server key never carries the prefix
  (CLAUDE.md §4).
- Never log tokens, coordinates, or full phone numbers.
- Treat all server data as untrusted when rendering user-generated content.
- Client-side validation is UX; the server is the control.

## Testing

Jest + `@testing-library/react-native`.

Tests assert **behaviour**:

```
Bad:   expect(store.getState().isAccepting).toBe(true)
Good:  user taps "Accept" → "On the way" is visible
```

- Every reusable component has a test.
- API interactions are tested against a mocked transport, not a live server.
- No blanket snapshot tests (CLAUDE.md §13).

Strategy: [`../engineering/testing-strategy.md`](../engineering/testing-strategy.md).

## The design system

Supplied by the owner and recorded in
[`../design/design-system.md`](../design/design-system.md)
([ADR-0011](../decisions/ADR-0011-design-system.md)). Colour, typography,
spacing, radius, and component appearance all come from
`src/theme/design-tokens.json`, which `tailwind.config.js` and
`src/theme/tokens.ts` both read.

Components are built and reviewed in Storybook before they reach a screen
([ADR-0012](../decisions/ADR-0012-component-workshop.md)):

```bash
pnpm --filter mobile storybook
```

Still the owner's to supply, and blocking nothing: app icon and splash artwork,
the Google Maps style JSON, illustration, and the motion language.
