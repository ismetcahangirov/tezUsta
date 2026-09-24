import { CALL_SURFACE_MUTED_OPACITY, CALL_SURFACE_SCHEME } from '../calls/call-surface-scheme';
import { contrastRatio } from './contrast';
import { colors, type ColorRole, type ColorScheme } from './tokens';

/** WCAG 2.1 §1.4.3 — normal-size text. */
const TEXT_MINIMUM = 4.5;
/** WCAG 2.1 §1.4.11 — meaningful non-text boundaries. */
const NON_TEXT_MINIMUM = 3;

const SCHEMES: ColorScheme[] = ['light', 'dark'];
const SURFACES: ColorRole[] = ['bg', 'surface', 'surface-alt'];
const TEXT_ROLES: ColorRole[] = ['text', 'text-muted', 'danger'];

describe.each(SCHEMES)('%s palette', (scheme) => {
  const palette = colors[scheme];

  describe.each(TEXT_ROLES)('"%s" is readable', (role) => {
    it.each(SURFACES)('on "%s"', (surface) => {
      expect(contrastRatio(palette[role], palette[surface])).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    });
  });

  it.each([
    ['on-accent', 'accent'],
    ['on-inverse', 'inverse-surface'],
    ['on-danger', 'danger'],
  ] as [ColorRole, ColorRole][])('"%s" is readable on "%s"', (foreground, background) => {
    expect(contrastRatio(palette[foreground], palette[background])).toBeGreaterThanOrEqual(
      TEXT_MINIMUM,
    );
  });

  it('separates a progress fill from the track it sits in', () => {
    expect(contrastRatio(palette.accent, palette.track)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
  });

  it('separates the focus ring from every surface it can appear over', () => {
    for (const surface of SURFACES) {
      expect(contrastRatio(palette.focus, palette[surface])).toBeGreaterThanOrEqual(
        NON_TEXT_MINIMUM,
      );
    }
  });
});

describe('the accent colour rule', () => {
  // The design system allows lime as a *text* colour in dark mode only. On the
  // light background it is a surface colour — never type, never an icon.
  // docs/design/design-system.md §"The accent rule".
  it('is legible as text in dark mode', () => {
    expect(contrastRatio(colors.dark.accent, colors.dark.bg)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it('is not legible as text in light mode, which is why the system forbids it', () => {
    expect(contrastRatio(colors.light.accent, colors.light.bg)).toBeLessThan(TEXT_MINIMUM);
  });
});

/**
 * `on-inverse` laid over `inverse-surface` at `opacity`, as the screen draws
 * it — the colour a reader actually sees, so its contrast can be measured.
 */
function blend(foreground: string, background: string, opacity: number): string {
  const channel = (hex: string, offset: number): number =>
    Number.parseInt(hex.replace('#', '').slice(offset, offset + 2), 16);
  return `#${[0, 2, 4]
    .map((offset) =>
      Math.round(
        channel(foreground, offset) * opacity + channel(background, offset) * (1 - opacity),
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * The call surface (ADR-0041): one appearance in both themes, drawn from
 * `CALL_SURFACE_SCHEME` whatever the device is set to. Every pair it uses is
 * measured here, once per device theme, so a palette change that breaks the
 * call screen in either theme fails the build.
 */
describe.each(SCHEMES)('the call surface, with the device in %s', () => {
  // The device theme names the case and is deliberately not read: the
  // surface does not follow it, which is the property being pinned.
  const palette = colors[CALL_SURFACE_SCHEME];
  const surface = palette['inverse-surface'];

  it('is #111 with #fff type — the dark theme’s own page and text', () => {
    expect(surface).toBe(colors.dark.bg);
    expect(palette['on-inverse']).toBe(colors.dark.text);
  });

  it('keeps its type readable', () => {
    expect(contrastRatio(palette['on-inverse'], surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it('keeps its muted type readable', () => {
    const muted = blend(palette['on-inverse'], surface, CALL_SURFACE_MUTED_OPACITY);
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it('may use lime as type — the running duration', () => {
    expect(contrastRatio(palette.accent, surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it('separates the accept fill from the surface, and its icon from the fill', () => {
    expect(contrastRatio(palette.accent, surface)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
    expect(contrastRatio(palette['on-accent'], palette.accent)).toBeGreaterThanOrEqual(
      NON_TEXT_MINIMUM,
    );
  });

  it('separates the danger fill from the surface, and its icon from the fill', () => {
    // 3.2:1 with the light `danger` — above the non-text minimum, so the
    // decline and hang-up buttons need no ring (ADR-0041 § 1).
    expect(contrastRatio(palette.danger, surface)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
    expect(contrastRatio(palette['on-danger'], palette.danger)).toBeGreaterThanOrEqual(
      NON_TEXT_MINIMUM,
    );
  });

  it('shows a toggle that is on: a filled disc with a dark icon', () => {
    expect(contrastRatio(palette['on-inverse'], surface)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
    expect(contrastRatio(surface, palette['on-inverse'])).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
  });

  it('shows a toggle that is off: a ring and a light icon on the surface', () => {
    expect(contrastRatio(palette['on-inverse'], surface)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
  });

  it('keeps the ended screen’s close button visible and its label readable', () => {
    expect(contrastRatio(palette.surface, surface)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
    expect(contrastRatio(palette.text, palette.surface)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });
});
