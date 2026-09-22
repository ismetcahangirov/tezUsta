# TezUsta design system

The visual language of the product. The project owner decided it (CLAUDE.md
§17); this document records what was decided and why, so that engineering can
build without inventing.

**The machine-readable source of truth is
[`apps/mobile/src/theme/design-tokens.json`](../../apps/mobile/src/theme/design-tokens.json).**
This page explains it. Where the two disagree, the token file wins and this page
is out of date.

| Where it lives                             | What it is                                            |
| ------------------------------------------ | ----------------------------------------------------- |
| `apps/mobile/src/theme/design-tokens.json` | Every value, once                                     |
| `apps/mobile/tailwind.config.js`           | Reads that file; emits the NativeWind utilities       |
| `apps/mobile/src/theme/tokens.ts`          | Reads that file; typed access for non-class contexts  |
| `apps/mobile/src/theme/contrast.test.ts`   | Fails the build if a palette change breaks legibility |
| `pnpm --filter mobile storybook`           | The components, in both themes, in a browser          |

---

## 1. Where it came from

The direction is adapted from **"Rift Flora" by Tianyi Ye**
([Behance](https://www.behance.net/gallery/196689303/Rift-Flora)), chosen by the
project owner. Its published style guide gives the palette and the typeface
outright; the rest was read off the screens.

What we took, verbatim:

| Element  | Reference                                                         |
| -------- | ----------------------------------------------------------------- |
| Palette  | `#111111` · `#c8f751` · `#f0f0f0` · `#cecece` · `#ffffff`         |
| Typeface | Anybody                                                           |
| Buttons  | Full pill. Black fill with white type; lime fill with black type. |
| Sheets   | Large top radius over a map, page-background fill                 |
| Controls | Circular icon buttons; a pill-in-a-pill segmented switch          |
| Progress | **Square ends** — the one un-rounded shape in the system          |
| Icons    | Monoline, geometric, light stroke                                 |
| Dividers | A hairline. No shadows anywhere.                                  |

What we changed, and why, is section 7.

---

## 2. Colour

Two complete themes. Every role exists in both; only the value differs.

### Light

| Role              | Value     | Use                                        |
| ----------------- | --------- | ------------------------------------------ |
| `bg`              | `#f0f0f0` | The page                                   |
| `surface`         | `#ffffff` | Cards, inputs, the segmented track         |
| `surface-alt`     | `#e4e4e4` | A quieter block inside a page              |
| `text`            | `#111111` | Body and headings                          |
| `text-muted`      | `#5c5c5c` | Secondary detail                           |
| `border`          | `#d4d4d4` | Hairline dividers and input outlines       |
| `accent`          | `#c8f751` | Fills only — see §3                        |
| `on-accent`       | `#111111` | Type on a lime fill                        |
| `inverse-surface` | `#111111` | The black pill button, the inverse card    |
| `on-inverse`      | `#ffffff` | Type on the inverse surface                |
| `danger`          | `#c0272d` | Cancellation, failure, destructive actions |
| `on-danger`       | `#ffffff` | Type on a danger fill                      |
| `track`           | `#111111` | The unfilled part of a progress bar        |
| `focus`           | `#111111` | Focus and selection rings                  |
| `overlay`         | `#111111` | Scrims, at reduced opacity                 |

### Dark

| Role              | Value     | Note                                                   |
| ----------------- | --------- | ------------------------------------------------------ |
| `bg`              | `#111111` |                                                        |
| `surface`         | `#1f1f1f` |                                                        |
| `surface-alt`     | `#2e2e2e` |                                                        |
| `text`            | `#ffffff` |                                                        |
| `text-muted`      | `#a1a1a1` |                                                        |
| `border`          | `#3a3a3a` |                                                        |
| `accent`          | `#c8f751` | Unchanged — the brand colour does not shift            |
| `on-accent`       | `#111111` |                                                        |
| `inverse-surface` | `#ffffff` | Inverts with the theme: the pill becomes white         |
| `on-inverse`      | `#111111` |                                                        |
| `danger`          | `#ff6b6b` | **Different value.** `#c0272d` reaches only 3.2:1 here |
| `on-danger`       | `#111111` |                                                        |
| `track`           | `#454545` | Black-on-black would be invisible                      |
| `focus`           | `#ffffff` |                                                        |
| `overlay`         | `#000000` |                                                        |

The palette is **closed**. `tailwind.config.js` replaces Tailwind's colours
rather than extending them, so `bg-blue-500` does not exist and cannot be
written by accident. The only non-token colour is `transparent`, because "no
fill" is not a design decision.

---

## 3. The accent rule

Lime is the brand. It is also nearly the brightness of white.

| Pair                   | Contrast   |
| ---------------------- | ---------- |
| `#c8f751` on `#111111` | **15.2:1** |
| `#111111` on `#c8f751` | **15.2:1** |
| `#c8f751` on `#ffffff` | 1.2:1      |
| `#c8f751` on `#f0f0f0` | 1.1:1      |

**On the light theme lime is a surface colour and never type or an icon.** It
fills a button, a badge, a progress bar — always with `#111111` on top. On the
inverse surface it may also be type, which is exactly how the reference uses it.

`contrast.test.ts` encodes both halves of this rule, including the negative one:
if someone changes `accent` to something that _would_ be legible on light, the
test fails and the decision gets revisited deliberately rather than by accident.

---

## 4. Status

The reference is a game and has no status colours. TezUsta needs them for order
state, verification state, and failure.

**The decision was minimal: lime, red, and neutral. Nothing else.**

| State       | Tone    | Example label    |
| ----------- | ------- | ---------------- |
| `pending`   | neutral | "Usta axtarılır" |
| `active`    | accent  | "Yolda"          |
| `done`      | accent  | "Tamamlandı"     |
| `cancelled` | danger  | "Ləğv edildi"    |

Three of the four states share a tone on purpose. **The label carries the
meaning; colour only narrows it down.** A colour-blind user, a user in sunlight,
and a screen-reader user all get the same information, and the brand stays as
tight as the reference's.

`StatusPill` requires a `label`. There is no way to render a status as colour
alone.

---

## 5. Typography

**Anybody** (Google Fonts, SIL OFL), shipped locally through
`@expo-google-fonts/anybody` — no CDN request at launch.

Azerbaijani coverage was verified against the shipped font file rather than
assumed: `ə Ə ğ Ğ ı İ ö Ö ü Ü ş Ş ç Ç` are all present in its `cmap`.

| Role          | Size / Line height | Family  |
| ------------- | ------------------ | ------- |
| `display`     | 32 / 36            | Bold    |
| `h1`          | 24 / 30            | Bold    |
| `h2`          | 20 / 26            | Bold    |
| `body`        | 15 / 22            | Regular |
| `body-strong` | 15 / 22            | Bold    |
| `caption`     | 13 / 18            | Regular |
| `footnote`    | 11 / 15            | Regular |

The reference's scale is 33 / 17 / 13 / 10. We moved it up one step: the
realistic device here is a mid-range Android, and a good share of masters are
not twenty-five years old. 13pt body was too tight to ship.

**Weight comes from the family, not from a weight utility.** React Native cannot
synthesise a bold from a regular face, so `font-bold` maps to
`Anybody_700Bold` and Tailwind's `fontWeight` core plugin is switched off.
There is no `font-semibold`, because there is no semibold face.

All type goes through the `Text` component. A raw `<Text>` from React Native
bypasses the scale.

---

## 6. Spacing, radius, size

```
space   0  4  8  12  16  20  24  32  40  48
radius  none 0 · sm 8 · md 16 · lg 28 · full 999
```

`space.0` exists so that "no gap" is a token rather than a literal `0` somebody
typed. It is the only zero the scale sanctions.

| Token             | Value | Use                                                |
| ----------------- | ----- | -------------------------------------------------- |
| `control-sm`      | 36    | Small button, segment                              |
| `control-md`      | 48    | Default button, input                              |
| `control-lg`      | 56    | Primary call to action                             |
| `icon-button`     | 44    | Circular control                                   |
| `touch-target`    | 44    | Minimum tap target for **any** interactive element |
| `avatar-sm`       | 32    | Avatar in a list row                               |
| `avatar-md`       | 44    | Avatar in a card header                            |
| `avatar-lg`       | 64    | Avatar on a profile screen                         |
| `progress-height` | 8     |                                                    |
| `hairline`        | 1     | Dividers, input outline                            |

`icon-button` and `touch-target` are both 44 and that is not a duplication to be
collapsed. `icon-button` is the drawn size of a circular control;
`touch-target` is the floor every interactive element must meet, including ones
that are drawn smaller and extend their hit area to reach it. They happen to
coincide because 44 is the platform minimum, and they would drift apart the
moment either changed for its own reason.

### Icons

| Token          | Value | Use                                      |
| -------------- | ----- | ---------------------------------------- |
| `icon.stroke`  | 1.75  | Every icon, everywhere. Never overridden |
| `icon.size.sm` | 16    | Inline with body text                    |
| `icon.size.md` | 20    | Default — list rows, buttons             |
| `icon.size.lg` | 24    | Headers, empty states                    |

A monoline icon set only reads as one set if the stroke never varies, so stroke
is a single token rather than a per-icon prop.

### The Android notification mark

`apps/mobile/assets/notification-icon.png` — 96×96, **all white, transparent
background**, wired into the `expo-notifications` plugin with
`color: tokens.color.light.accent` (issue #158).

The constraint is Android's, not ours: the notification icon is drawn as a
**silhouette**. Every non-transparent pixel becomes solid and is then tinted, so
a coloured or detailed logo arrives as a white blob. That is the usual way this
goes wrong.

The mark is a ring spanner at 45°, proportioned after the Lucide `Wrench` glyph
that is already in the icon inventory — filled rather than monoline, because a
1.75-unit stroke disappears when Android scales 96px down to the ~24dp it draws
in the status bar. **It is an interim mark**: the brand mark itself does not
exist yet, and this is the domain glyph from the set this document already
settled, not a logo. Replacing it is a file swap plus a new build — both this
and the tint are written into the manifest at build time and cannot be changed
over the air.

`radius.none` is not padding for the scale. The progress bar is the only
square-ended element in the system, and it is square on purpose: everything else
is rounded, so the sharp bar reads as a measurement rather than as a surface.

---

## 7. Where dark is used

Both themes ship in full and follow the device setting
(`userInterfaceStyle: 'automatic'`), with a manual override in settings.

Independently of the theme, some surfaces are **deliberately inverse** — dark in
the light theme, as the reference does:

- Launch and splash
- Sign-in and onboarding — "before you are in" should not look like the product
- The primary call-to-action pill

---

## 8. What we changed from the reference, and why

| Change                             | Reason                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Body type 13 → 15                  | Mid-range Android, and an audience that is not all young                                                                 |
| Added `danger`                     | The reference has no failure state; an order can be cancelled                                                            |
| Separate dark `danger`             | The light red reaches 3.2:1 on `#111111` — below the readable minimum                                                    |
| Dropped `#cecece` as a text colour | It fails against every surface. It survives only as a border/fill value                                                  |
| Added a second dark surface        | The reference's dark screens use translucency; opaque steps are cheaper to render and easier to test                     |
| Lucide icon set                    | The reference's icons are custom. Lucide is the closest maintained open set; stroke and colour are forced through tokens |

---

## 9. What is still the owner's to decide

Not invented here, and not blocking the component library:

- **App icon, adaptive icon, and splash artwork.** Expo's defaults apply until
  they are supplied. The Android notification mark is no longer among them — §6
  records the interim one and what replacing it costs.
- **Map styling** — the Google Maps style JSON that matches this palette.
- **Illustration and empty-state art.** The reference's are game-specific.
- **Motion** — durations and easing. Components animate nothing today.
- **The navigation pattern** — settled for the **customer** in
  [ADR-0030](../decisions/ADR-0030-customer-root-navigation-and-order-list.md)
  and [ADR-0031](../decisions/ADR-0031-where-settings-is-reached-from.md): a
  three-tab bar at the root of `(customer)` — catalogue, orders, settings — with
  flows pushed over it. The **master's** root is still a single stack, with
  settings reached from a control on their home until a job list gives that tree
  a bar of its own; what else goes in it is still open.
- **The onboarding flow** — what a first-run user is shown, and in what order.
- **The content of an empty state** — the words and the illustration, as
  distinct from the components it is assembled from.

**Settled since this document was written:** the tab bar takes its tints from
`text` and `text-muted` — never `accent`, which § 3 forbids as type or an icon on
a light surface (ADR-0030). And `StatusTone` gained a fifth member,
`unfilled`, for `NO_MASTER_FOUND` — rendered with the neutral badge and named
apart from `pending` and `cancelled` because it is neither a wait nor a
cancellation ([ADR-0029](../decisions/ADR-0029-customer-order-screen.md)).

The last two are screen-level product decisions rather than visual tokens, so
this document does not settle them and neither does `CLAUDE.md` § Design
decisions. That section's "stop and ask" rule still applies to them in full.

---

## 10. Rules for engineering

1. No colour, size, radius, or type value is written in a component. It comes
   from a token, or it is a bug.
2. Style with NativeWind classes. `useTheme()` is for the places a class cannot
   reach — the status bar, a navigator option, an SVG stroke, a map style.
3. Class names must be literals. Tailwind scans source text, so a computed
   `text-${variant}` produces no CSS at all.
4. A new component gets a story **and** a co-located test before it is used in a
   screen.
5. Adding a colour means changing `design-tokens.json` and watching `contrast.test.ts`.
   If the test fails, the colour is wrong — not the test.

Related: [ADR-0011](../decisions/ADR-0011-design-system.md) (the design system),
[ADR-0012](../decisions/ADR-0012-component-workshop.md) (Storybook).
