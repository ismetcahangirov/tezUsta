# Mobile architecture

Expo SDK 57, React Native 0.86, React 19.2.3, Expo Router, NativeWind 4.
Versions and reasoning: [`technology-stack.md`](technology-stack.md).

The web admin panel, `apps/admin`, is a separate client with its own section at
the end: [The admin panel](#the-admin-panel-appsadmin-issue-247).

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

`app/call/` is the one root directory the guard lets a signed-in user of either
role into besides `(shared)` (issue #188): a call is presented over whatever is
on screen, for whichever side of the order placed it, so it cannot live inside
one role's group. Who may call about which order is the server's decision on
every invite.

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
| The call ringing this phone         | A Redux slice (`src/calls/ringing-call-slice.ts`) — the `Call` contract only, never the room credential (issue #188)           |

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

### The call surface (issue #188)

The screens for an in-app voice call
([ADR-0034](../decisions/ADR-0034-in-app-voice-calls.md),
[ADR-0039](../decisions/ADR-0039-call-surfaces-and-ring-push-ahead-of-the-spike.md),
[ADR-0040](../decisions/ADR-0040-call-screens.md)) live in `src/calls/`, beside
the two reducers and the signalling hooks they render.

**The reducers decide; the screen renders.** `CallScreen` takes a `CallState`
and draws whichever phase it is in — outgoing, incoming, connecting, active,
reconnecting, ended — and every control only reports a tap. `useOutgoingCall`
and `useIncomingCall` hold the reducer; `OutgoingCallSurface` and
`IncomingCallSurface` join a hook to the screen, and the two routes under
`app/call/` do nothing but read their parameter. A screen that decided anything
about a call would be a second state machine disagreeing with the first.

**Two root routes, full-screen modals with gestures off**:
`/call/outgoing/[orderId]`, opened by `CallEntry` on the order screen's status
card, the master's job and the conversation header; and
`/call/incoming/[callId]`, pushed by the root's ring listener
(`IncomingCallListener`, inside `RealtimeProvider` in `app/_layout.tsx`) when a
`call:incoming` frame arrives. The listener writes the ring into the
`ringingCall` slice first; the incoming route reads it once and keeps its own
copy, because the slice lets go of the call when it ends while the ended screen
stays until it is closed. A second ring while any call screen holds a live call
is ignored — the server has already answered that caller `busy`. Each screen
records itself in the slice under a token of its own, so a screen that closes
can only withdraw its own record.

**The microphone is asked when the call earns it.** `useMicrophonePermission`
wraps `expo-audio`'s prompt behind `microphone-adapter.ts`, the only file that
imports it. An incoming call asks on accept, never on arrival; an outgoing call
asks in its `permissions` phase, which only a tap on the call button reaches. A
refusal is an end reason (`permission_denied`), not a dialog, and nothing is
sent to the server that would open a room.

**Ships dark.** `CALLING_ENABLED` in `src/calls/calling-enabled.ts` is `false`
until the room bridge lands (ADR-0039 § 3): every entry point renders nothing
and the listener ignores a ring, because without the bridge an answered call
would sit in `connecting` forever. Tests force it on with `jest.mock`. Mute and
speaker are local toggles on the screen until then; they change nothing about
the audio, because there is no room for them to act on.

**One appearance in both themes**
([ADR-0041](../decisions/ADR-0041-call-surface-fixed-appearance.md)): the
surface is pinned to the light palette with `FixedScheme`
(`src/theme/FixedScheme.tsx`), which re-declares the colour variables for its
subtree with NativeWind's `vars()` and tells `useTheme` the same, so classes
and JS-coloured icons agree. `#111` with `#fff` type whatever the device says;
`contrast.test.ts` measures every pair the surface uses.

**A live call is held on screen.** `useHoldCallScreen` refuses the screen's
removal — Android's hardware back included — until the call has ended
(`usePreventRemove`, re-exported by `expo-router/react-navigation`). Under it,
`useCall.ts` tells the server once, by phase, if a screen goes away mid-call
anyway. The routes close at once while calling ships dark, so a deep link
cannot place an invite; the listener lets go of a ring whose call ends before
its screen mounts, and a ring over an ended call screen replaces it.

**A ring push wakes the app, and the server decides whether it rings**
(#189, ADR-0039 § 4–6).

- **Confirmed before it rings.** A tapped `call-incoming` notification, or one
  that arrives while the app is open, is confirmed with `GET /calls/:callId`
  (`confirmRingingCall`). Only a call that is `RINGING` with this account as
  its `callee` is presented, through `usePresentIncomingCall`, the one path to
  the incoming screen that the socket's ring also uses. Otherwise a tap opens
  the order as before.
- **Silent in the foreground.** The foreground handler shows no banner and plays
  no sound for a ring push, because the in-app ring is the ring. It stays
  listed in the tray, in case both the socket and the confirmation read fail.
- **One dependency direction.** `notifications` imports `calls` through
  `calls/index.ts`; `calls` imports nothing from `notifications`. The incoming
  route hands the push adapter's dismissal to the surface as `onRingStopped`,
  and the frame-driven dismissal lives in `notifications`
  (`RingNotificationDismissal`).
- **Taken down when the call is over.** The notification is dismissed on any
  `call:*` frame for its id, on a confirmation that finds the call over, and
  when this phone answers or declines.
- **Killed app.** It keeps the notification until it is tapped.
- **The hold on hardware back uses the `live` predicate** (`isHeld`: past
  `permissions`, before `ended`). A ring arriving while the microphone question
  is up can therefore replace that screen instead of being silently refused.
- **The unmount safety net is deferred a tick**, and the next mount cancels it,
  so a StrictMode or Fast Refresh remount never ends a call on screen.

The duration is derived from the reducer's `connectedAt` once a second
(`useCallDuration`), never counted and never sent: the server computes its own.
Every string is placeholder copy in `call-copy.ts`, and none of the nine
end-reason sentences says "error".

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

## The admin panel (`apps/admin`, issue #247)

Everything above is the Expo app. The admin panel is a second, separate client:
a Vite 8 + React 19.2.3 single-page app with `react-router@7`, Redux Toolkit +
RTK Query and Tailwind 3.4.17
([ADR-0043](../decisions/ADR-0043-admin-panel-policy.md) § 8). It shares no
source with `apps/mobile` — dependency-cruiser forbids either importing the
other — and takes its contracts from `packages/types`.

### Same origin, cookies, and the one base query

The panel only ever calls `/api/admin/...` on its own origin. In development
the Vite dev server proxies `/api` to the API on port 3000 and strips the
prefix; in production a reverse proxy does the same in front of the static
files. The API enables no CORS (ADR-0043 § 4).

The session is two httpOnly cookies the page cannot read, so the panel holds
**no token anywhere** — not in Redux, not in `localStorage`. `adminBaseQuery`
(`src/api/base-query.ts`) is the only way out of the app:

- every request is `credentials: 'same-origin'` and carries
  `X-TezUsta-Admin: 1`, the CSRF header the API requires;
- a 401 from any route outside `/admin/auth/*` triggers **one** refresh and one
  retry. Concurrent 401s share the same refresh promise, because the refresh
  cookie rotates on every use and presenting a rotated one again revokes the
  session;
- a refused refresh (401/403) sets `session.signedOut`, and the shell gives way
  to `/sign-in`. A refresh that got no answer (network, 5xx) does not sign the
  tab out — it is no evidence the session is over.

Later screens (#248–#251) add endpoints with `adminApi.injectEndpoints`, so they
inherit all of this.

### Screens

- `/sign-in` — email, password and code in one request; one message for every
  credential failure, because the server does not say which factor was wrong.
- `/setup` — reads the setup token from the URL fragment, removes it from the
  URL with `history.replaceState`, and keeps it in memory only. Shows the
  account, a QR code of the `otpauth://` URI drawn locally with `uqr` (never a
  QR service — the URI carries the secret) and the key in text. If the offered
  enrolment expires (fifteen minutes), the page asks the server for a new one
  with the same in-memory token rather than sending the admin back for a new
  link.
- Everything else sits in the shell: `GET /admin/me` on load, a fixed left
  navigation filtered by `permissions`, and a top bar with the admin's name,
  roles and sign-out. A route reached by URL without its permission renders a
  "no access" state. Both are presentation only — the server checks every
  request (ADR-0043 § 1).

Desktop only, on purpose (≥ 1024 px). Copy lives in `src/copy.ts`.

### Feature folders and the page registry (#248 onwards)

Each section of the panel is a folder under `src/features/<section>/` holding
everything that section owns: its endpoints (`api.ts`, injected into the one
`adminApi` slice with its own tag type), its copy (`copy.ts`), its pages and
components, and co-located tests. Two sections never import each other; what
they share lives in `src/components/` (`Modal`, `ReasonField`, `Table`) and
`src/format.ts`.

A feature reaches the router through `src/shell/pages.tsx` and nowhere else:

- `PAGES`, keyed by the section's path in `NAVIGATION`, names the page a
  section renders. A section without an entry keeps its placeholder.
- `NESTED_PAGES` lists pages opened from inside a section — `/masters/:id` —
  each with the permission of the section it belongs to.

`App.tsx` wraps both in `RequirePermission`, so adding a screen is one line in
the registry and no change to routing. Per-action permissions are checked in
the page against `useSignedInAdmin().permissions` to decide which buttons are
drawn; that is presentation only, and the server refuses the request anyway.

Two rules every screen follows:

- **A presigned URL is never cached.** Document and photo downloads are
  audited reads that mint a short-lived URL; they are RTK Query mutations
  dispatched with `track: false`, and `openInNewTab` opens the tab inside the
  click (so no popup blocker intervenes) and points it at the URL once it
  arrives, with `opener` cut.
- **A reason is checked before it is sent** — trimmed, 1–600 characters, the
  API's own bounds — and an error is shown by its stable `error.code`, never
  by the server's message.

The master verification screens (#248) are the first feature built this way:
`/masters` lists masters by verification status (in `?status=`, the review
queue first) with cursor paging through an RTK Query infinite query, and
`/masters/:id` shows the profile, the documents and the verification trail,
with the five review actions offered by permission and by the master's status.

Order oversight (#249) follows the same shape in `features/orders/`:

- `/orders` filters by status (several at once), "stuck" and a creation date
  range, all held in the URL. The date inputs are calendar days in the admin's
  time zone; `to` is sent as the start of the following day because the API's
  upper bound is exclusive. `/disputes` is the server's queue, oldest first.
- `/orders/:id` shows the summary, address, both parties with masked numbers,
  the status history (oldest first, with the admin's name on an override),
  photos and — for a disputed order, and only when the admin asks — the
  transcript, which is an audited read cached for no longer than it is shown.
- **The override dialog lists exactly `detail.transitions`.** The panel has
  no copy of the order state machine; it only knows which permission a target
  needs (`RESOLVED` → `disputes.resolve`, `REFUNDED` → `disputes.refund`,
  anything else → `orders.override`) and disables, with the reason, an option
  the role may not take or the server marks unavailable (`REFUNDED` until
  EPIC 12).
- **A revealed phone number never reaches the store.** The reveal is
  dispatched with `track: false` and the number lives in the dialog's own
  state; closing it discards the only copy, and the next reveal is a new
  audited request with a new reason.
- Money is integer qəpik from the API and is shown through one helper,
  `formatMoney` in `src/format.ts` (`Intl.NumberFormat('az-AZ', AZN)`). Tests
  assert through the same helper, because ICU renders AZN differently on
  Windows and on the Linux CI.

### Tokens and theme

`src/theme/design-tokens.json` is a copy of `apps/mobile`'s tokens, because one
app may not import another; `design-tokens.test.ts` reads both files from disk
and fails on any drift. The colours are CSS variables switched by
`prefers-color-scheme` (Tailwind `darkMode: 'media'`), so a component is correct
in both schemes without a `dark:` variant. Anybody is shipped with the app from
`@expo-google-fonts/anybody` — the same files the mobile app bundles — not
fetched from a CDN.

### Testing

Vitest + Testing Library + jsdom. Tests render the whole app — real store,
real router, real base query — against a fake `fetch`
(`test/fake-server.ts`), and assert what an admin sees and what reached the
API. No database is involved, so the suite runs in CI's `pnpm test` beside the
others.
