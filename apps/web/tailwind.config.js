/**
 * Tailwind for the web subscription page — the ADR-0011 tokens, and nothing
 * else. The same configuration as the admin panel's (ADR-0061 § 1).
 *
 * Every value is read from src/theme/design-tokens.json; nothing here is a
 * literal. Colours are CSS variables that switch with `prefers-color-scheme`
 * (the `media` strategy): the page follows the operating system, and the
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
    // Cahan Serif ships two weights, so there are two and no others. Its italics
    // are faces of their own (`italic`), not a synthesised slant.
    fontWeight: { regular: '400', bold: '700' },
    fontFamily: {
      sans: [tokens.typography.family, 'Georgia', 'serif'],
    },
    extend: {
      // `page` is the single column's measure — a layout dimension of this
      // app, not a design-system token. The layout is a placeholder (ADR-0061).
      width: px(tokens.size),
      maxWidth: { page: '480px' },
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
