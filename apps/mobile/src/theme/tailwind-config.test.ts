import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { colors, space } from './tokens';

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

const MOBILE_ROOT = path.resolve(__dirname, '../..');

/** The utilities that read `theme.spacing`, longest first so `gap-x` is not read as `gap`. */
const SPACING_UTILITIES = [
  'translate-x',
  'translate-y',
  'space-x',
  'space-y',
  'inset-x',
  'inset-y',
  'min-w',
  'min-h',
  'gap-x',
  'gap-y',
  'inset',
  'bottom',
  'right',
  'left',
  'size',
  'gap',
  'top',
  'px',
  'py',
  'pt',
  'pr',
  'pb',
  'pl',
  'ps',
  'pe',
  'mx',
  'my',
  'mt',
  'mr',
  'mb',
  'ml',
  'ms',
  'me',
  'p',
  'm',
  'w',
  'h',
];

/**
 * A numeric spacing class: it starts a string, or follows a space or a
 * variant's colon, and a leading `-` is a negative margin. Group 1 is the
 * utility, group 2 the step.
 */
const SPACING_CLASS = new RegExp(
  `(?:^|[\\s'"\`:])-?(${SPACING_UTILITIES.join('|')})-(\\d+(?:\\.\\d+)?)(?![\\w.-])`,
  'gm',
);

/** Every source file the app is built from; tests render no layout, so they are left out. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every numeric spacing class in the app names a step the scale has (#454).
 *
 * `tailwind.config.js` *replaces* the spacing scale with `space` from
 * `design-tokens.json`, and `size-*`, `w-*`, `h-*`, padding, margin and gap
 * all read it. A step the scale does not have, such as `size-20`, produces no
 * CSS at all, and Jest renders no layout to notice. The order photos drew at
 * 0 × 0 that way: React Native gives a network or file `Image` no size of its
 * own.
 */
describe('the spacing classes', () => {
  it('use only steps the spacing scale defines', () => {
    const steps = new Set(Object.keys(space));
    const found = ['src', 'app']
      .flatMap((directory) => sourceFiles(path.join(MOBILE_ROOT, directory)))
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(SPACING_CLASS)].map((match) => ({
          where: `${path.relative(MOBILE_ROOT, file)}: ${match[1] ?? ''}-${match[2] ?? ''}`,
          step: match[2] ?? '',
        })),
      );

    // A guard that matches nothing passes forever; the app has hundreds of these.
    expect(found.length).toBeGreaterThan(200);
    expect(found.filter(({ step }) => !steps.has(step)).map(({ where }) => where)).toEqual([]);
  });
});
