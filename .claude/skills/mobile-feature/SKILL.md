---
name: mobile-feature
description: Use when building or changing anything in apps/mobile — screens, components, Expo Router routes, TanStack Query hooks, Zustand state, permissions, or secure storage. Triggers on "add screen", "mobile UI", "React Native component", "app feature", or work under apps/mobile.
---

# Build a mobile feature

Expo SDK 57, Expo Router, NativeWind 4, TanStack Query, Zustand. Reference:
`docs/architecture/frontend-architecture.md`.

## STOP — check for a design decision first

**The project owner owns the visual design system** (CLAUDE.md §17).

Do **not** invent: colours, typography, spacing, icon style, card or button
appearance, navigation pattern, map UI, onboarding, or empty states.

If the task needs one of those and it has not been given:

> "Implementing the order tracking screen requires deciding how the master's live
> position and ETA are presented. Please provide the intended design."

Then label the issue `needs-design-decision` and build what is not blocked.

**No hardcoded design values in a component.** Colour, spacing, and type come from
`src/theme`. A hex literal in a component is a design decision engineering was
not entitled to make.

## State — the boundary is not negotiable

| State                                            | Owner                                 |
| ------------------------------------------------ | ------------------------------------- |
| Orders, masters, services, statuses              | **TanStack Query**                    |
| Auth session                                     | Secure storage + a thin Zustand slice |
| Selected role, order draft, map camera, UI prefs | **Zustand**                           |

**If the server is the source of truth, it does not belong in Zustand.** Copying
server data into a global store means re-implementing caching, invalidation,
retry, and staleness by hand — and getting it wrong.

### Query conventions

```ts
// Hierarchical keys so invalidation can be targeted
[
  'orders',
] // everything
[('orders', 'list', filters)][('orders', orderId)];
```

- Mutations **invalidate**; hand-patch the cache only where optimistic update is
  genuinely warranted (accepting an order).
- Realtime events invalidate or patch the relevant query — **the socket does not
  become a second store**.
- Set `staleTime` deliberately: the catalogue is stable for minutes; an active
  order is not.
- **Never `useEffect` + `fetch`.** No dedup, no retry, no cache, races on unmount.
- **Do not override `retry` per query without a reason.** The shared policy is
  `shouldRetry` in `src/api/query-client.ts`: backoff on a failure with no
  readable status, and **never a retry on a 4xx**. Retrying a `429` burns the
  user's remaining OTP budget three times as fast as the server's rate limit
  assumes, and a `401` retried underneath the refresh-and-replay cycle multiplies
  it.
- Mutations carry an **idempotency key** — a retried order creation must not
  create two orders.

## Components

The layout is **flat files in one directory**, with a single shared barrel — not
a directory per component. Follow what is there:

```
apps/mobile/src/components/
  Button.tsx
  Button.test.tsx        # co-located, always
  Button.stories.tsx     # co-located, always
  ...
  index.ts               # one barrel re-exporting all 13 components and their types
```

A new component adds three files beside the others and one export block to
`index.ts`. Do not introduce a second layout next to the existing one.

**Every component has a `.stories.tsx`, and the story is the review surface.**
Run `pnpm --filter mobile storybook` and look at the component in both themes
before wiring it into a screen (CLAUDE.md §17).

Presentational components take props and hold no server state. Feature components
may use query hooks.

## Permissions — the highest-friction moment

1. Request **at the point of need**, with a plain explanation. Never at first
   launch — it gets denied by reflex.
2. **Background location only when an order is accepted**; stop when it ends.
   Continuing afterwards is a privacy violation and an app-store review failure.
3. **Every denial has a path forward** — manual address entry. A denied
   permission must never dead-end the flow.
4. Handle "granted once", "while using", and permanent denial distinctly.
5. Android battery optimisation will kill background reporting — detect staleness
   and warn the master rather than silently showing them active.

## Security

- Tokens in **`expo-secure-store`**. `AsyncStorage` is forbidden — it is
  unencrypted plaintext (CLAUDE.md §20).
- **`EXPO_PUBLIC_` embeds the value in the shipped bundle**, readable by anyone
  who unzips the APK. A value is a **secret** if it grants server authority or
  billing power — a signing key, a database URL, an SMS or storage credential,
  the billable `GOOGLE_MAPS_SERVER_API_KEY`. Those never carry the prefix. The
  one documented exception is a **platform-restricted client map key**
  (`EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY`, `..._IOS_API_KEY`): restricted by
  bundle id / package name and scoped to the Maps SDK, shipped because the client
  cannot render a map without it, and protected by the restriction rather than by
  secrecy. Anything else new behind the prefix needs the same two properties, or
  it belongs to the API.
- Never log tokens, coordinates, or full phone numbers.
- Client validation is UX; the server is the control.

## Performance — target is mid-range Android

| Concern       | Rule                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| Long lists    | `FlatList`/`FlashList`, stable `keyExtractor`. Never `.map()` a long list.  |
| Keys          | Stable ids, **never array indices** on a reorderable list                   |
| Re-renders    | Memoise expensive children; keep fast-changing values out of shared context |
| Live location | **Interpolate the marker between updates** — do not raise update frequency  |
| Images        | Size and cache; never render a full-resolution upload in a list             |
| Maps          | One instance per screen; release on unmount                                 |
| Animation     | Reanimated on the UI thread                                                 |

The interpolation rule matters: smoother tracking is a **rendering** problem.
Fixing it with more GPS updates spends the master's battery and the customer's
data.

## Installing packages

```bash
npx expo install expo-location     # ✅ matches the SDK
pnpm add expo-location             # ❌ installs latest, may be a different SDK
```

Run the `verify-dependency` skill for anything non-Expo.

## Tests

Behaviour, not implementation:

```ts
// ❌
expect(store.getState().isAccepting).toBe(true);
// ✅
await user.press(screen.getByRole('button', { name: 'Accept' }));
expect(await screen.findByText('On the way')).toBeVisible();
```

Every reusable component has a test covering render, interaction, and its
loading / empty / error states. No blanket snapshot tests.

## Before finishing

```bash
pnpm verify
```

- [ ] No hardcoded design values
- [ ] No blocked design decision silently invented
- [ ] Server state in TanStack Query, not Zustand
- [ ] Loading, empty, and error states all handled
- [ ] Permission denial has a working path
- [ ] No new `EXPO_PUBLIC_` value that grants server authority or billing power
- [ ] Co-located `.test.tsx` and `.stories.tsx`, exported from `index.ts`
- [ ] New components reviewed in Storybook, in both themes, before wiring
