import { colors } from './tokens';

/**
 * The selectors the colour variables are declared under, which decide whether
 * the dark palette reaches the phone at all.
 *
 * Jest does not run NativeWind's CSS compiler, so no rendered test can see
 * this: with the dark variables under a bare `.dark`, every component test
 * passed while the app on the A36 stayed light in "Qaranlıq" (25 October
 * 2026). NativeWind reads dark-scheme variables on native only from
 * `.dark:root`, `:root[class~=dark]` or `.dark *`
 * (`react-native-css-interop/src/css-to-rn/normalize-selectors.ts`).
 */

interface TailwindConfig {
  readonly plugins: ((api: { addBase: (rules: Record<string, unknown>) => void }) => void)[];
}

function declaredBase(): Record<string, Record<string, string>> {
  // The config is CommonJS, read by Tailwind and Metro; it has no types to import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  const config = require('../../tailwind.config.js') as TailwindConfig;
  const rules: Record<string, Record<string, string>> = {};
  for (const plugin of config.plugins) {
    plugin({
      addBase: (added) => {
        Object.assign(rules, added);
      },
    });
  }
  return rules;
}

function channels(hex: string): string {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).join(' ');
}

describe('the colour variables', () => {
  it('declares the light palette on :root', () => {
    expect(declaredBase()[':root']?.['--color-bg']).toBe(channels(colors.light.bg));
  });

  it('declares the dark palette under .dark:root, a selector NativeWind applies on native', () => {
    const base = declaredBase();

    expect(base['.dark:root']?.['--color-bg']).toBe(channels(colors.dark.bg));
    expect(base['.dark:root']?.['--color-surface']).toBe(channels(colors.dark.surface));
    expect(Object.keys(base)).not.toContain('.dark');
  });
});
