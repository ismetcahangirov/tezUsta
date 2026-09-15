# ADR-0011 — Design system: palette, typography, and the token contract

- **Status:** **Accepted** (owner art pending)
- **Date:** 2026-09-14
- **Decided by:** Project owner

## Context

CLAUDE.md §17 puts the visual design system with the project owner, and it had
never been supplied. That single gap blocked every UI issue — #30, #33, #38 all
carried `needs-design-decision` — and `docs/architecture/frontend-architecture.md`
listed six things it could not specify.

The owner supplied a direction: **"Rift Flora" by Tianyi Ye**
([Behance](https://www.behance.net/gallery/196689303/Rift-Flora)), to be adapted
to TezUsta.

## Decision

The design system recorded in
[`docs/design/design-system.md`](../design/design-system.md), with these choices
made by the owner:

| Question                    | Decision                                                |
| --------------------------- | ------------------------------------------------------- |
| Themes                      | **Light and dark, both complete**, following the device |
| Status colours              | **Minimal: lime, red, neutral.** Nothing else           |
| Type scale                  | One step up from the reference — **15dp body**, not 13  |
| Accent (`#c8f751`) on light | **Surface colour only. Never type, never an icon**      |

**Token contract:** every value lives once, in
`apps/mobile/src/theme/design-tokens.json`. `tailwind.config.js` and
`src/theme/tokens.ts` both read that file, so a NativeWind utility and a runtime
token cannot describe different colours. Tailwind's own palette is **replaced**
rather than extended — the set of available colours is closed.

## Why

**Two themes, not one.** The reference itself uses both a light page and dark
immersive screens, and Android has exposed a system dark setting for years. The
cost is real (every token has two values, every component is reviewed twice) and
was accepted deliberately.

**Minimal status colours.** The reference is a game and has none. Adding a full
semantic palette would have been the conventional move and would have diluted a
near-monochrome brand. Instead the label carries the meaning and colour only
narrows it: three of the four order states share a tone. This also happens to be
the accessible answer — a colour-blind user, a user in sunlight, and a
screen-reader user all receive the same information.

**15dp body.** The reference specifies 13pt. The realistic device here is a
mid-range Android, and a meaningful share of masters are not twenty-five. 13dp
was too tight to ship.

**The accent rule, with evidence.** `#c8f751` measures **15.2:1** against
`#111111` and **1.2:1** against `#ffffff`. It is a fill, not a foreground. The
reference never breaks this either; the rule just makes it explicit.

**A separate dark red was forced, not chosen.** `#c0272d` reaches only 3.2:1 on
`#111111`, below the readable minimum, so the dark theme uses `#ff6b6b` (6.8:1).

**Typeface verified, not assumed.** Azerbaijani needs `ə` (U+0259), which many
Latin faces omit. The shipped Anybody font file was downloaded and its `cmap`
inspected: all of `ə Ə ğ Ğ ı İ ö Ö ü Ü ş Ş ç Ç` are present. Had they not been,
the typeface would have been unusable regardless of how it looks.

## Alternatives considered

| Option                                    | Why not                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Light theme only                          | Cheaper, but the reference's own identity is partly the dark screens, and Android users expect the setting |
| Dark theme only                           | Map screens dominate this product and Google Maps renders light by default                                 |
| Full semantic palette (success/warn/info) | More scannable in isolation; dissolves a deliberately monochrome brand, and encourages colour-only meaning |
| Keep the reference's 13pt body            | Visually truest, and wrong for the device and the audience                                                 |
| Hard-code values in components            | Fastest today. Guarantees drift, and makes a later rebrand a full-codebase edit                            |
| Tokens duplicated in TS and Tailwind      | Simpler to read; two sources of truth that silently diverge                                                |

## Trade-offs accepted

- **Two themes doubles visual review.** Every component needs looking at twice,
  and the palette carries two values per role.
- **A closed palette is rigid by design.** There is no escape hatch: adding a
  colour means editing the token file and satisfying the contrast test.
- **No literal may appear in a component**, which occasionally costs a token for
  a one-off.
- **`#cecece` from the reference's style guide did not survive** as a text
  colour — it fails against every surface. It remains only as a border/fill idea.

## Consequences

- `apps/mobile/src/theme/` is populated; issue #20's placeholder tokens become
  real values.
- `src/theme/contrast.test.ts` fails the build if a palette change breaks
  legibility, including the negative half of the accent rule.
- `tailwind.config.js` disables Tailwind's `fontWeight` core plugin: React
  Native cannot synthesise a weight, so weight comes from the font _family_.
- Issues #30, #33, and #38 lose `needs-design-decision`.
- `packages/typescript-config/base.json` became self-contained — its relative
  `extends` out of the package resolved differently through a workspace symlink
  and broke Rolldown (see ADR-0012).

## Revisit when

- The owner supplies the app icon, map style, illustration, or motion language.
- A screen genuinely cannot be expressed in the current token set — which is a
  reason to extend the tokens, not to write a literal.
