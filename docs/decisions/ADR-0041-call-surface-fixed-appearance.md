# ADR-0041 — The call surface has one appearance in both themes

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** [ADR-0040](ADR-0040-call-screens.md) § 2 (the inverse
  surface) and § 4 (how the toggles show their state). The rest of ADR-0040
  stands unchanged: one full-screen modal, the layout, which controls each
  phase has, the ended screen staying until closed, the entry point and the
  copy.
- **Decided by:** the code review of
  [#217](https://github.com/ismetcahangirov/tezUsta/pull/217), under the
  project owner's delegation of EPIC 18's design decisions (2026-09-24).
- **Issues:** [#188]

[#188]: https://github.com/ismetcahangirov/tezUsta/issues/188

## Context

ADR-0040 § 2 put the call on `inverse-surface` with `on-inverse` type "in both
themes". The inverse surface inverts with the theme
([design system](../design/design-system.md) § 2): it is `#111111` in light
and **`#ffffff` in dark**. So in dark mode the call screen was white, and the
review of #217 measured what that does to the pairs the screen depends on:

| Pair on the dark theme's inverse surface (`#ffffff`) | Contrast | Needed |
| ---------------------------------------------------- | -------- | ------ |
| Lime duration (`accent` as type)                     | 1.24:1   | 4.5:1  |
| Lime accept fill against the surface                 | 1.24:1   | 3:1    |
| Dark `danger` fill (`#ff6b6b`) against the surface   | 2.78:1   | 3:1    |

ADR-0040 § 4 also drew a toggle's two states as two fills — `on-inverse` on,
`surface-alt` off. `#e4e4e4` against `#ffffff` is 1.3:1. The state was
effectively carried by nothing a sighted user could see.

## Decision

### 1. One fixed appearance

The call surface is **`#111111` with `#ffffff` type in both themes**. That is
the light palette's `inverse-surface` / `on-inverse`, which are also the dark
palette's `bg` / `text`. **No new colour is introduced.**

Mechanism: the whole call surface (the screen and the route's safe-area frame)
is drawn from the **light palette**, pinned with `FixedScheme`
(`apps/mobile/src/theme/FixedScheme.tsx`).

- **Classes.** The NativeWind utility classes resolve through CSS variables
  (`bg-inverse-surface` is `rgb(var(--color-inverse-surface))`). `FixedScheme`
  re-declares those variables for its subtree with NativeWind's `vars()`, using
  the same token file `tailwind.config.js` reads.
- **JS colours.** A context makes `useTheme` answer the pinned scheme, so
  icons and spinners follow it too.
- **Constant.** `CALL_SURFACE_SCHEME` (`src/calls/call-surface-scheme.ts`) names
  the palette in one place.

Measured on that surface (`contrast.test.ts`, "the call surface", once per
device theme):

| Pair                                                 | Contrast | Needed |
| ---------------------------------------------------- | -------- | ------ |
| `on-inverse` type on the surface                     | 18.88:1  | 4.5:1  |
| Muted type (`on-inverse` at 80 % opacity, `#d0d0d0`) | 12.24:1  | 4.5:1  |
| Lime duration as type                                | 15.18:1  | 4.5:1  |
| Lime accept fill against the surface                 | 15.18:1  | 3:1    |
| Light `danger` fill (`#c0272d`) against the surface  | 3.21:1   | 3:1    |
| `on-danger` icon on the danger fill                  | 5.88:1   | 3:1    |
| Close button (`surface`) against the surface         | 18.88:1  | 3:1    |

**Lime is legal on this surface** as type (the running duration) and as the
accept fill, in both themes.

**The danger fill passes at 3.21:1, narrowly.** The decline, cancel and hang-up
buttons therefore carry **no extra ring**. Each also has a white icon and an
accessibility label, so its meaning never rests on the fill's boundary alone.
If `danger` is ever darkened, `contrast.test.ts` fails, and a hairline
`on-inverse` ring around the danger buttons is the agreed fallback.

### 2. Toggles show state by fill, outline and glyph

Mute and speaker each have two states:

| State | Fill                    | Outline                      | Icon                                           |
| ----- | ----------------------- | ---------------------------- | ---------------------------------------------- |
| On    | `on-inverse` (white)    | none                         | dark (`inverse-surface`): `MicOff` / `Volume2` |
| Off   | none (`bg-transparent`) | a hairline `on-inverse` ring | white (`on-inverse`): `Mic` / `Volume1`        |

- The glyph changes with the state. Muted shows `MicOff`, live shows `Mic`.
  The loudspeaker shows `Volume2` and the earpiece shows `Volume1`.
- The state is therefore never carried by the fill alone.
- The control keeps its `selected` accessibility state, so a screen reader
  hears it too.
- `IconButton` gains the `inverse-outline` variant for the off state. The
  unused `surface-alt` fill that ADR-0040 § 4 asked for is removed.

## Alternatives considered

| Option                                          | Why not                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Follow the device theme (white surface in dark) | The failures in the table above.                                                                                                                       |
| Dark theme `bg` / `text` with the dark `danger` | `#ff6b6b` on `#111` passes, but the danger red would then differ between the two themes' calls, and the light theme's call would need a third palette. |
| A new call-only colour                          | The palette is closed (design system § 2). Existing tokens already give the pair.                                                                      |
| A `dark:` variant on every call class           | Doubles every class, and misses the colours `useTheme` hands to icons in JS.                                                                           |

## Trade-offs accepted

- The call screen ignores the device theme entirely, which ADR-0040 already
  accepted in spirit. This ADR makes it literal.
- The danger fill's margin is small (3.21 against 3.0). The contrast test is
  what keeps it honest.

## Revisit when

The palette changes, or the owner supplies a call-specific visual treatment.
