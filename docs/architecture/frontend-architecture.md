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
│   ├── (customer)/             # customer role group — (tabs)/ + screens pushed over them
│   ├── (master)/               # master role group
│   └── (shared)/               # settings — one screen, rendered by two routes
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
| Whether the socket is up            | A Redux slice (`src/realtime/connection-slice.ts`) — it is about the transport, not about an order                             |
| Messages written but not yet sent   | A Redux slice (`src/conversation/outbox-slice.ts`) — the server has never seen them (issue #182)                               |

**Rule: if the server is the source of truth, it does not belong in a slice**
(CLAUDE.md). Copying server data into the store means re-implementing caching,
invalidation, retry, and staleness by hand — and getting it wrong.

### The socket patches the cache; it is never a second store (issue #170)

**One connection for the app**, opened at the root by `RealtimeProvider` once a
session exists and closed on sign-out. A `useEffect` that opened a socket inside
a screen would open one per screen, and each would count against the server's
`REALTIME_MAX_CONNECTIONS_PER_USER`. Screens ask it for **rooms**
(`useOrderRoom`); the server decides whether they may have them (issue #167),
and a refusal is not surfaced — the screen's data comes over HTTP either way.

**Every event ends at `api.util.invalidateTags` or `updateQueryData`.** A
transition patches the order's own entry with the three fields it carries and
invalidates the order _list_, which can reorder in ways the payload does not
describe. Even the master's position — which has no HTTP endpoint and never will
— goes into a cache entry of its own (`masterPosition`, a `queryFn` that returns
`null` and is written rather than fetched), because a socket feeding a parallel
slice would give the app two answers to "what is this order's status" and no
rule for which wins.

**The conversation follows the same rule (issue #182,
[ADR-0037](../decisions/ADR-0037-conversation-screen.md)).** `message:new` is
placed into the history cache by id and time, `message:read` stamps `readAt` on
the user's own messages, and `conversation:typing` is a written-not-fetched
entry like the position. None of the three goes through the sequence guard. A
message is not a newer version of the order, and the guard would drop one
stamped a millisecond before a transition. Room joins are **counted**, so a
conversation pushed over the order screen can leave the order's room without
deafening the screen underneath. The one thing kept in a slice is the outbox:
an unsent message is not server state, and keeping it out of the cache is
what stops a reconnection's refetch from wiping a failed send.

**The app works with the socket permanently down.** Nothing waits for a
connection, nothing blocks on one, and no screen reads its data from it. A phone
on a network that blocks WebSocket shows a `reconnecting` indicator and a fully
working app.

**Backgrounding drops the socket on purpose.** React Native freezes the JS
thread, so a socket "kept" across an hour in a pocket is a connection the OS may
have torn down silently, feeding a screen that looks live. The connection
remembers its rooms, re-joins them on every `connect`, and treats coming back as
a reconnection — which is what triggers the HTTP refetch that repairs whatever
was missed. Reconnection itself is socket.io's own backoff, bounded at 30 s and
**jittered**, so an API restart is not answered by every phone at the same
instant.

**An event older than one already applied is discarded**, per order, comparing
the payload's `at`. Out-of-order arrival is normal under reconnection; a tie is
kept, because `at` is a millisecond timestamp rather than a sequence.

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

### The master's position reporter (issue #171)

`src/location/` is the master's side of the budget
([`realtime-architecture.md`](realtime-architecture.md) § Location update
budget, [ADR-0026](../decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).
Four pieces, and the split is the point:

| File                  | What it owns                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `location-budget.ts`  | **Every number.** The state table, the staleness threshold, the backoff |
| `location-port.ts`    | What the reporter needs from a platform                                 |
| `location-adapter.ts` | The only file that imports `expo-location`                              |
| `reporter.ts`         | The state machine: floor, surplus, backoff, staleness                   |

**The floor is a timer and the surplus is a subscription, and they are two
mechanisms deliberately.** `expo-location`'s `timeInterval` is Android-only, so
a floor built on it would not exist on iOS — and the floor is what
`DISPATCH_MAX_POSITION_AGE_SECONDS` is derived from. A movement-only reporter
deletes every parked master from every broadcast, which is the regression
ADR-0026 exists for and the first test in `reporter.test.ts` is named after.

**Foreground permission is asked from one call site**: the availability toggle,
on the way online, after the server has agreed — the same shape as
`usePushAccessPrompt` below and for the same reason. A denial degrades: the app
works, offers arrive, and the master is told that without a position they will
not be reached.

**Background location is not requested anywhere, and `app.config.js` does not
declare it.** It is asked for when an order is accepted and never before — and
this app has no accept surface, so the entitlement would be a permission
nothing uses. The same reason `travelling` and `working` are in the budget table
and cannot yet be selected: the master has no job list, so nothing knows there
is an order.

**Staleness is the server's answer, not a second client-side clock.** A killed
reporter stops reporting, presence expires, `MasterAvailability.isLive` goes
false, and `AvailabilityToggle` already renders that divergence. The reporter's
own `stale` flag exists for a screen that needs it sooner; nothing renders two
warnings for one fact.

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

### One Android channel per category, and the ids are permanent

`notification-channels.ts` (issue #157) is the table `ensureChannels` walks: the
manifest's `default` channel plus one per `NotificationCategory`, created in the
order our own settings screen lists them. The API addresses a channel on every
message it sends (`channelIdOfKind`), and the two lists have to name the same
ids — Android does the matching and reports nothing when it fails, delivering a
message that names an unknown channel into the manifest's default instead.

**A channel is a second control, not a copy of the preference switch.** The
switch in TezUsta's settings is enforced on the server (#143) and stops the
notification being sent; the channel is enforced by the phone and cannot be
seen from the server at all. Both exist because they answer different questions,
and an offer arriving as a banner while progress updates stay in the tray is
only possible through the channel.

Two platform facts govern edits here:

- **A channel's importance, sound and vibration are frozen at creation.**
  Changing them in code does nothing on a phone that already has the channel;
  only a new id takes effect, and it leaves the old channel in the user's
  settings list forever. Ids are therefore permanent, which is why the tests
  assert them as literals.
- **The default channel stays.** It is the fallback for a phone whose release
  predates a category the server has learned.

Nothing here reaches iOS, which has no channels: `ensureChannels` returns
immediately and the sender's `channelId` is ignored.

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

**A customer opens the order; a master opens their home.** Since #155 the
customer half is real: `resolveNotificationRoute` returns
`/(customer)/order/[id]` with the id the target has always carried. The master
half is still the role home, because there is no master-facing order screen and
no offer feed — naming a route that does not exist is the guess the table exists
to prevent, and this is the one place that changes when one does.

### The customer's order screen

`OrderDetail` (issue #155,
[ADR-0029](../decisions/ADR-0029-customer-order-screen.md)) is a stack screen at
`app/(customer)/order/[id].tsx`, reachable from order creation and from a
notification.

**A status card, not a stepper.** One `StatusPill` plus one sentence saying what
happens next. The lifecycle is not a line — re-dispatch returns an accepted
order to `SEARCHING`, a dispute branches, `NO_MASTER_FOUND` ends it early — so a
position on a track would be a claim the state machine does not support.
`order-status-presentation.ts` maps all fourteen statuses as a total `Record`,
which makes a status added to
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md) without copy a
compile error rather than a blank card.

**The screen is told an id and nothing else.** No order object crosses a
navigation boundary: a status carried in a route parameter is a status that was
true when the navigation started, and what changed since then is the whole point
of the screen. The service name and the address are resolved through the
endpoints that already cache them, because `Order` carries ids rather than
copies.

**A 404 is a message, not an error.** The API answers 404 for an order that is
not the caller's, never 403, so "no such order" and "not yours" render as one
plain line with no retry button — a retry that can never succeed is worse than
no retry. A 403 is treated the same way, so a raw permission error can never
reach a customer.

**It reads; it does not act.** No cancel control, because the cancellation
policy is undecided and a control about money has to be able to say what it
costs. It opens no socket either — live status and position are EPIC 9.

### The customer's root, and the way back to an order

`app/(customer)/(tabs)/` is a two-tab navigator — the catalogue and the order
list — inside the stack `(customer)/_layout.tsx` already owned (issue #160,
[ADR-0030](../decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
Order creation, one order and saved addresses stay **outside** the group and
push over the bar: a tab is a place you return to, a stack screen is a place you
came from. The group is invisible in a path, so `/(customer)` still resolves to
the first tab and nothing that navigated there had to change.

The master's root stays a single stack until it has a second destination worth
returning to. The pattern is decided for both roles; where it applies is a
function of what the tree contains, not a uniformity to be imposed on a screen
with nothing to put in a second tab.

**`Orders` (issue #160) pages with `build.infiniteQuery`, not with a merged
cache entry.** `createOrder` invalidates `{ type: 'Order', id: 'LIST' }`, and a
single entry with `serializeQueryArgs` + `merge` answers an invalidation by
refetching only its most recent argument and merging that page back into pages
it never re-read — which duplicates every row that has since shifted a page
down. The cursor is the server's, opaque, and keyset-based, which is what makes
"an order created mid-paging does not repeat a row" true at all.

**Open orders are separated from finished ones on the client**, over the pages
already loaded: "open" is nine of the fourteen statuses and `GET /orders`'s
`?status=` takes one. `isOrderOpen` is a total `Record` beside the tone table,
for the same compile-time reason. The known limit — an open order older than
everything loaded is not pinned until it is paged to — is recorded in ADR-0030
rather than worked around.

**Paging is a control, not a scroll position.** A list that fetches the next
twenty rows because a finger moved spends mobile data on rows nobody asked for,
and a button is the half of the screen a screen-reader user can operate.

### Settings, and the two ways into it

`src/settings/Settings.tsx` is a component, not a route, since issue #164
([ADR-0031](../decisions/ADR-0031-where-settings-is-reached-from.md)). Two
routes render it: the customer's third tab (`(customer)/(tabs)/settings.tsx`)
and `(shared)/settings.tsx`, which is what the master pushes from a control in
their home screen's title row.

**One implementation, two routes, and the split is the router's constraint
rather than a preference** — an Expo Router `Tabs.Screen` names a route inside
its own directory, so a screen that is a tab for one role and a pushed screen
for the other cannot be a single route. The role-dependent part of the screen
(saved addresses are a customer concept) was already a branch inside it and
stays one. `(shared)` keeps the route rather than a copy moving under
`(master)/`: the route guard already treats that group as visitable from either
role, and a master-only copy would make that answer untrue.

Until #164 the route was linked from **no screen in the app**, which meant
nobody could sign out, change the appearance, switch role, or turn a
notification category off. The screen also scrolls now: with a tab bar under it
and every notification category the server serves inside it, the sign-out
controls were below the fold.

### Preferences are the server's list, rendered

`NotificationPreferences` (issue #147) is a section of `(shared)/settings`.
**No category is named anywhere in the app's source.** The list, each current
value, and whether each may be switched off all arrive from
`GET /notification-preferences`; a category the server adds appears on the
next fetch, under its own key until somebody writes it a name — rendering it
ugly beats dropping it, because a toggle that vanished reads as a missing
feature.

`changeable` is read, never re-derived. Two copies of "which categories are
mandatory" is how an app ends up disagreeing with the worker that enforces it,
and today only one of the five is changeable at all.

**There is no switch in the design system, and one is not invented.** The
inventory is settled ([ADR-0011](../decisions/ADR-0011-design-system.md)) and
has no toggle, so `PreferenceList` uses `SegmentedControl` — the same answer
`AvailabilityToggle` gave to the same problem. A locked category gets **no
control at all** rather than a greyed-out one, since a disabled style is a
visual decision nobody has made; it gets a `StatusPill` and a sentence, which
is what makes it visible and explained rather than absent.

The write is optimistic and **the rollback is the part that is tested**. These
are small, frequent taps and a round trip per tap reads as a broken control —
but a toggle that springs back with no explanation is worse than one that
refused, so `patch.undo()` restores the value and the screen says why. `PUT`
carries the whole set, because the body is the state.

Whether the operating system is blocking notifications outright is read by
`useOsNotificationPermission` and shown above the list with a route into the
system settings: five switches that cannot do anything is not a settings
screen. It re-reads on `AppState` `active`, so returning from those settings
does not need an app restart — the same rule location permission already
follows.

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
