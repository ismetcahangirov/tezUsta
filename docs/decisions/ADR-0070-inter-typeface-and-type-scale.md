# ADR-0070 — Every surface is set in Inter, on a larger type scale

- **Status:** **Accepted**
- **Date:** 2026-10-28
- **Decided by:** Project owner. On 28 October 2026 the owner asked for the
  typography of the whole project to move to Inter, slightly larger and with a
  clearer hierarchy, "inspired by Bolt.new" while keeping the project's own
  colours, layout and spacing. The owner gave the family, the weights
  (400 / 500 / 600 / 700) and a starting scale; the steps below adapt it.
- **Supersedes:** the typeface of [ADR-0065](ADR-0065-cahan-serif-typeface.md)
  and [ADR-0066](ADR-0066-cahan-serif-on-admin-and-web.md), and the type scale
  of [ADR-0011](ADR-0011-design-system.md) (design system § 5). The wordmark
  stays in Neuron, as outlines.

## Decision

1. **Inter 4.1** (rsms/inter, SIL OFL) replaces Cahan Serif in `apps/mobile`,
   `apps/admin` and `apps/web`. The files are vendored, not fetched: the web
   CSP is `font-src 'self'` and the app ships its fonts.
2. **Four weights.** Regular 400, Medium 500, SemiBold 600, Bold 700, with an
   italic of each.
   - `apps/mobile` ships the eight static TTFs; weight still comes from the
     family (`font-regular`, `font-medium`, `font-semibold`, `font-bold`,
     and `-italic` variants), because React Native cannot synthesise one.
   - `apps/admin` and `apps/web` ship Inter's variable WOFF2, one file per
     slant. Its optical-size axis sets large headings in the Inter Display
     cut on its own, so no separate display family is declared.
3. **The scale** (size / line height in px; `wide` is where a heading ends up on
   a 1440 px viewport on the web surfaces, reached with `clamp()` from the phone
   size at 375 px; the phone always uses the first value):

   | Role          | Size / LH | Wide    | Weight   | Tracking |
   | ------------- | --------- | ------- | -------- | -------- |
   | `display`     | 36 / 40   | 48 / 52 | Bold     | −0.025em |
   | `h1`          | 28 / 34   | 32 / 38 | SemiBold | −0.02em  |
   | `h2`          | 22 / 28   | 24 / 30 | SemiBold | −0.015em |
   | `lead`        | 18 / 28   | —       | Regular  | 0        |
   | `body`        | 16 / 24   | —       | Regular  | 0        |
   | `body-strong` | 16 / 24   | —       | SemiBold | 0        |
   | `caption`     | 14 / 20   | —       | Regular  | 0        |
   | `footnote`    | 12 / 16   | —       | Regular  | 0        |

   `lead` is new: a page's opening paragraph. Buttons stay on `body-strong`.
   Navigation uses the medium face (semibold when active).

4. **A step carries its weight.** On the web, `text-h2` sets size, line height,
   tracking and weight together, so the `font-bold` that used to follow every
   heading class is gone. A weight utility is now only emphasis inside a step,
   and that emphasis is `font-semibold`. Regular steps set no weight, so they
   inherit.

## Verification

All sixteen files carry `ə Ə ğ Ğ ı İ ö Ö ü Ü ş Ş ç Ç` and `₼` in their `cmap`
and report the expected weight and italic bit. Both web builds were served
locally: every element resolved to `Inter, ui-sans-serif, system-ui,
sans-serif`, the variable face loaded from the app's own origin, and nothing
was fetched from another origin.

## Consequences

- The app's font payload grows from about 1.1 MB (four Cahan Serif TTFs) to
  about 3.4 MB (eight Inter TTFs). Subsetting them is possible, but it would
  drop Cyrillic and other scripts that customers may type in names and
  messages, so it is not done here.
- Each web app ships two WOFF2 files (352 kB upright, 388 kB italic). The italic
  one is fetched only when italic text is rendered.
- Body text goes from 15 to 16 px and headings grow one step, so a long
  Azerbaijani title wraps a little sooner on a narrow phone.
