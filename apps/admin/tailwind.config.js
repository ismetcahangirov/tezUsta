/**
 * Tailwind for the admin panel — the ADR-0011 tokens, and nothing else.
 *
 * Every value is read from src/theme/design-tokens.json; nothing here is a
 * literal. Colours are CSS variables that switch with `prefers-color-scheme`
 * (the `media` strategy): the panel follows the operating system, and the
 * variables change underneath the same utility classes, so no component
 * needs a `dark:` variant to be correct in both schemes.
 */
import { readFileSync } from 'node:fs';

const tokens = JSON.parse(
  readFileSync(new URL('./src/theme/design-tokens.json', import.meta.url), 'utf8'),
);

/** `#rrggbb` -> `"r g b"` for `rgb(var(--x) / <alpha-value>)`. */
function channels(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).join(' ');
}

function schemeVariables(scheme) {
  return Object.fromEntries(
    Object.entries(tokens.color[scheme]).map(([role, hex]) => [`--color-${role}`, channels(hex)]),
  );
}

const px = (record) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, `${value}px`]));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    // Replaced, not extended: the palette is closed by design (ADR-0011).
    colors: {
      transparent: 'transparent',
      ...Object.fromEntries(
        Object.keys(tokens.color.light).map((role) => [
          role,
          `rgb(var(--color-${role}) / <alpha-value>)`,
        ]),
      ),
    },
    spacing: px(tokens.space),
    borderRadius: px(tokens.radius),
    fontSize: Object.fromEntries(
      Object.entries(tokens.typography.scale).map(([role, { size, lineHeight }]) => [
        role,
        [`${size}px`, { lineHeight: `${lineHeight}px` }],
      ]),
    ),
    // Anybody ships two faces, so there are two weights and no others.
    fontWeight: { regular: '400', bold: '700' },
    fontFamily: {
      sans: [tokens.typography.family, 'system-ui', 'sans-serif'],
      // Only for a secret typed by hand into an authenticator, where telling
      // `0` from `O` matters more than the typeface.
      mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
    },
    extend: {
      // `nav` is the fixed navigation column (ADR-0043 § 8) — a layout
      // dimension of this app, not a design-system token.
      width: { ...px(tokens.size), nav: '240px' },
      margin: { nav: '240px' },
      height: px(tokens.size),
      minHeight: px(tokens.size),
      minWidth: px(tokens.size),
      borderWidth: { hairline: `${tokens.size.hairline}px` },
    },
  },
  plugins: [
    ({ addBase }) =>
      addBase({
        ':root': { ...schemeVariables('light'), colorScheme: 'light dark' },
        '@media (prefers-color-scheme: dark)': { ':root': schemeVariables('dark') },
      }),
  ],
};
