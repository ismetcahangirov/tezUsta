# ADR-0048 — Blue brand colour and the tezUsta wordmark

- **Status:** Accepted
- **Date:** 11 October 2026
- **Decided by:** Project owner, 11 October 2026. The owner fixed the exact
  brand value `#1877F2` and supplied the logo.
- **Amends:** [ADR-0011](ADR-0011-design-system.md) — the palette, the accent
  rule (§ 3) and the launch-art item still owed. Typeface, spacing, radius,
  elevation, icons and the token contract are unchanged.

## Context

ADR-0011 adapted a reference whose brand colour is lime `#c8f751`. Lime is
nearly as bright as white, so it could only ever be a fill under black type,
and it left TezUsta without a logo, app icon or splash artwork — all listed
there as the owner's to supply.

The owner has now decided the brand is **blue `#1877F2` and white**, and
supplied the logo: the wordmark "tezUsta" set in Neuron (Regular), converted to
outlines, white on `#1877F2`, centred exactly.

## Decision

1. **The accent is `#1877f2` in both themes, and the type on it is white.**
   Neutrals keep their roles. The light neutrals take a very slight cool tint
   so they sit with the blue; the dark neutrals are untouched.

   | Role          | Light                     | Dark                      |
   | ------------- | ------------------------- | ------------------------- |
   | `accent`      | `#1877f2` (was `#c8f751`) | `#1877f2` (was `#c8f751`) |
   | `on-accent`   | `#ffffff` (was `#111111`) | `#ffffff` (was `#111111`) |
   | `bg`          | `#f0f2f5` (was `#f0f0f0`) | unchanged                 |
   | `surface-alt` | `#e4e6eb` (was `#e4e4e4`) | unchanged                 |
   | `border`      | `#ced0d4` (was `#d4d4d4`) | unchanged                 |
   | `track`       | `#111111` (unchanged)     | `#ffffff` (was `#454545`) |

   The dark `track` becomes the dark theme's text colour, mirroring light,
   where the track is the light theme's text colour. Blue on the old `#454545`
   reached only 2.26:1, so a filled bar would have been hard to read against it.

2. **The accent rule: the accent is a fill in both themes, never type.** It
   fills a button, badge, progress bar or selected marker, with `on-accent`
   white on top. It is not used as text or as an icon colour on any surface
   (ADR-0030's tab-bar rule already avoids it). The call screen's running
   duration, which was lime type on `#111111`, becomes `on-inverse` white.

3. **The contrast trade-off, accepted.**

   | Pair                   | Contrast |
   | ---------------------- | -------- |
   | `#ffffff` on `#1877f2` | 4.23:1   |
   | `#1877f2` on `#111111` | 4.46:1   |
   | `#1877f2` on `#1f1f1f` | 3.89:1   |
   | `#1877f2` on `#f0f2f5` | 3.78:1   |
   | `#1877f2` on `#ffffff` | 4.23:1   |

   White on the accent passes WCAG AA for large text (3:1) and for non-text
   contrast (3:1). It does **not** reach 4.5:1 for normal-size text. The owner
   fixed the exact brand value, so this is accepted knowingly rather than
   worked around. The accent is also under 4.5:1 as type on every surface,
   which is why decision 2 forbids it. `contrast.test.ts` pins
   `on-accent` on `accent` at ≥ 4.2 as a regression floor instead of 4.5, so
   a drift lower still fails.

4. **The logo.** The wordmark is Neuron (Regular) as outlines — **no font file
   ships and the UI typeface stays Anybody.** Sources are Adobe Illustrator
   files; derived assets are checked in under
   [`docs/design/brand/`](../design/brand/):

   | Asset                                            | Use                                                                      |
   | ------------------------------------------------ | ------------------------------------------------------------------------ |
   | `source/*.ai`                                    | Editable Illustrator sources                                             |
   | `tezusta-logo-on-blue.svg/.png`                  | 1600×1000, white wordmark on blue                                        |
   | `tezusta-icon.svg`, `tezusta-icon-{16…1024}.png` | Square app icon, wordmark 78% wide                                       |
   | `tezusta.ico`                                    | 16–256 multi-size favicon                                                |
   | `tezusta-adaptive-foreground.svg/.png`           | 1024 transparent; wordmark 60% wide, inside Android's adaptive safe zone |
   | `tezusta-wordmark-blue.svg/.png`                 | Transparent, tight, 1103×309, for light surfaces                         |
   | `tezusta-wordmark-white.svg/.png`                | Transparent, tight, 1103×309, for dark and blue                          |

5. **Where it is used.**
   - Splash: the accent blue with the white wordmark (it was the dark inverse
     surface).
   - Sign-in stays the inverse surface and shows the white wordmark at the top.
   - App icon: `tezusta-icon-1024`; Android adaptive icon: the foreground above
     over an accent background.
   - Notification tint: the accent. The notification silhouette itself is still
     the interim spanner (design-system § 6).
   - Admin panel: the favicon (`.ico`, SVG, apple-touch-icon) and the blue
     wordmark in the navigation and on the sign-in card.

## Consequences

- `design-tokens.json` changes in `apps/mobile` and in `apps/admin`'s copy; the
  drift test keeps them equal.
- Any screen that used the accent as type or as an icon colour must move to
  `text` or `on-inverse`. Components that put `text` on an accent fill move to
  `on-accent`.
- App icon and splash artwork leave the owner-owned list. Map style,
  illustration and empty-state art remain.
- The brand cannot be regenerated from the repo's tokens alone; the Illustrator
  sources are the record, and an edit there means re-exporting the derived set.

## Alternatives considered

- **`#166FE5` for strict AA.** White on it reaches about 4.7:1. Rejected for now
  because the owner fixed `#1877F2` exactly. It is a one-token change, plus
  re-exporting the icon assets, if strict AA is wanted later.
- **Keeping lime.** Rejected by the owner; the brand is blue and white.
- **Shipping Neuron as the UI font.** Rejected: it is licensed as a logo
  typeface here and Anybody already covers the UI (ADR-0011). Outlines carry the
  logo without a font file.
