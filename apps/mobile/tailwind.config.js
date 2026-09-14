/**
 * NativeWind / Tailwind configuration.
 *
 * Every value comes from src/theme/design-tokens.json — the same file the typed
 * runtime theme reads. Nothing here is a literal, so a utility class and a JS
 * token cannot describe different colours.
 *
 * Colours are emitted as CSS variables and switched by the `dark` class, which
 * is the theming approach NativeWind v4 documents.
 */
const tokens = require('./src/theme/design-tokens.json');

/** `#rrggbb` -> `"r g b"` for `rgb(var(--x) / <alpha-value>)`. */
function channels(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).join(' ');
}

/** Semantic role -> `rgb(var(--color-role) / <alpha-value>)`. */
const colorVariables = {
  // The only colour that is not a token: "no fill" is not a design decision.
  transparent: 'transparent',
  ...Object.fromEntries(
    Object.keys(tokens.color.light).map((role) => [
      role,
      `rgb(var(--color-${role}) / <alpha-value>)`,
    ]),
  ),
};

/** Scheme -> `{ '--color-role': 'r g b' }`. */
function schemeVariables(scheme) {
  return Object.fromEntries(
    Object.entries(tokens.color[scheme]).map(([role, hex]) => [`--color-${role}`, channels(hex)]),
  );
}

const spacing = Object.fromEntries(
  Object.entries(tokens.space).map(([step, value]) => [step, `${value}px`]),
);

const borderRadius = Object.fromEntries(
  Object.entries(tokens.radius).map(([name, value]) => [name, `${value}px`]),
);

const fontSize = Object.fromEntries(
  Object.entries(tokens.typography.scale).map(([role, { size, lineHeight }]) => [
    role,
    [`${size}px`, { lineHeight: `${lineHeight}px` }],
  ]),
);

const sizes = Object.fromEntries(
  Object.entries(tokens.size).map(([name, value]) => [name, `${value}px`]),
);

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  corePlugins: {
    // The typeface ships as static TTFs, so weight comes from the *family*
    // (`font-regular` / `font-bold`), not from a numeric weight React Native
    // cannot synthesise. Leaving the core plugin on would emit a second,
    // conflicting `.font-bold` rule.
    fontWeight: false,
  },
  theme: {
    // `colors` is replaced, not extended: the palette is closed by design.
    // A component cannot reach for `blue-500`, because there is no blue-500.
    colors: colorVariables,
    spacing,
    borderRadius,
    fontSize,
    extend: {
      fontFamily: {
        regular: [tokens.typography.family.regular],
        bold: [tokens.typography.family.bold],
      },
      width: sizes,
      height: sizes,
      minHeight: sizes,
      minWidth: sizes,
      borderWidth: { hairline: `${tokens.size.hairline}px` },
    },
  },
  plugins: [
    ({ addBase }) =>
      addBase({
        ':root': schemeVariables('light'),
        '.dark': schemeVariables('dark'),
      }),
  ],
};
