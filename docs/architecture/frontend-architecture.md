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
│   ├── _layout.tsx             # providers: query client, auth, theme
│   ├── (auth)/                 # unauthenticated
│   ├── (customer)/             # customer role group
│   ├── (master)/               # master role group
│   └── (shared)/               # profile, settings
├── src/
│   ├── api/                    # typed API client, TanStack Query hooks
│   ├── components/             # reusable components (+ co-located tests)
│   ├── features/               # feature modules: orders, matching, tracking
│   ├── stores/                 # Zustand — client state only
│   ├── lib/                    # secure storage, location, permissions
│   └── theme/                  # design tokens — populated by the owner
└── assets/
```

Route groups keep role trees separate and make the router guard obvious. The
guard is **UX only** — the server enforces authorization on every request
([`authentication.md`](authentication.md)).

## State management

**TanStack Query owns server state. Zustand owns client state. The boundary is
not negotiable.**

| State                               | Owner                                 |
| ----------------------------------- | ------------------------------------- |
| Orders, masters, services, statuses | TanStack Query                        |
| Auth session (tokens)               | Secure storage + a thin Zustand slice |
| Selected role (customer/master)     | Zustand                               |
| In-progress order draft             | Zustand                               |
| Map camera, UI preferences          | Zustand                               |

**Rule: if the server is the source of truth, it does not belong in Zustand**
(CLAUDE.md). Copying server data into a global store means re-implementing
caching, invalidation, retry, and staleness by hand — and getting it wrong.

### Query conventions

- Structured, hierarchical query keys: `['orders', orderId]`, `['orders', 'list', filters]`.
- Mutations **invalidate** rather than hand-patching the cache, except where
  optimistic update is genuinely warranted (accepting an order).
- Realtime events invalidate or patch the relevant query — **the socket does not
  become a second store**. One cache, one source of truth.
- Sensible `staleTime` per resource: the service catalogue is stable for minutes;
  an active order is not.
- **No `useEffect` + `fetch`.** That pattern has no dedup, no retry, no cache,
  and races on unmount.

## Data fetching and offline behaviour

Mobile networks in this market are unreliable. This is a normal condition, not an
edge case.

- Retry with exponential backoff, except on 4xx — retrying a validation failure
  is pointless.
- **Mutations carry an idempotency key.** A retried order creation must not
  create two orders.
- Show real state: loading, empty, and error are distinct. An indefinite spinner
  is a bug.
- Cached data may be shown stale with an indication, rather than showing nothing.

## Components

```
components/
  OrderCard/
    OrderCard.tsx
    OrderCard.test.tsx
    index.ts
```

- Co-located tests, always (CLAUDE.md §13).
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

## Security on the client

- Tokens in `expo-secure-store`. **Never `AsyncStorage`** (CLAUDE.md §20).
- **Nothing secret behind `EXPO_PUBLIC_`** — that prefix embeds the value in the
  shipped bundle, readable by anyone who unzips the APK.
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
