# ADR-0066 — The admin panel and the web page are set in Cahan Serif too

- **Status:** **Accepted**
- **Date:** 2026-10-25
- **Decided by:** Project owner. On 25 October 2026, after the mobile app moved to Cahan Serif (ADR-0065), the owner asked for the admin panel and the web page to follow ("onları da keçir").
- **Context:** Issue #452.
- **Supersedes:** § 5 of [ADR-0065](ADR-0065-cahan-serif-typeface.md), which kept Anybody on `apps/admin` and `apps/web`.

## Context

ADR-0065 set every piece of text in `apps/mobile` in Cahan Serif and left the
admin panel and the master's web subscription page on Anybody, because the
request named the app. With all three surfaces on one typeface,
`@expo-google-fonts/anybody` has no consumer left.

Both web apps serve their fonts from their own origin: the CSP is
`font-src 'self'` (ADR-0052, ADR-0061), so a CDN copy is not an option.

## Decision

1. **`apps/admin` and `apps/web` are set in Cahan Serif.** Each app's token
   copy names the family `Cahan Serif`, Tailwind's `font-sans` follows it, and
   the fallback becomes `Georgia, serif` so a page that has not yet fetched the
   face falls back to a serif rather than a sans.
2. **Four faces ship in each app, as WOFF2:** Regular, Bold, Italic and Bold
   Italic, from `src/fonts/` with `OFL.txt`, declared through `@font-face`
   under one family with `font-weight` and `font-style`. On the web the
   italics are real faces, so Tailwind's `italic` picks them and nothing is
   slanted synthetically. The browser fetches a face only when a page uses it.
3. **WOFF2, not the TTFs `apps/mobile` ships.** They are the same faces from
   the owner's same build, at about a quarter of the size (66–85 kB a face),
   and every browser these apps support reads them. React Native cannot, which
   is why the app keeps TTFs.
4. **`@expo-google-fonts/anybody` leaves the repository.**
5. **No header changes.** The faces are bundled and same-origin, so the CSP
   stands as it is.

## Verification

The four WOFF2 files carry `ə Ə ğ Ğ ı İ ö Ö ü Ü ş Ş ç Ç` and `₼`, and report
weights 400 and 700 with the italic bit set on the italics. Each app's
production build was served locally and opened in a browser: every element
resolved to `"Cahan Serif", Georgia, serif`, the regular and bold faces
loaded, both italics loaded when asked for, and no resource was fetched from
another origin. The wordmark on the web page is SVG and is unchanged.

## Consequences

- One typeface across the app, the panel and the page, and one fewer
  dependency.
- Each web app holds its own copy of the font files, as each holds its own
  copy of the tokens, until the design system moves into a shared package
  (ADR-0016).
