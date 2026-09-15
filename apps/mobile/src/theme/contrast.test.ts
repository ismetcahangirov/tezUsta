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
