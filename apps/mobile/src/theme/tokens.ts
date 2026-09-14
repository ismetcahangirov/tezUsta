/**
 * Typed, runtime access to the design tokens.
 *
 * `design-tokens.json` is the single source of truth — `tailwind.config.js` reads the
 * same file, so a NativeWind utility and a JS token can never drift apart.
 * The file is not called `tokens.json`: next to `tokens.ts` that name makes
 * `./tokens` ambiguous, and a bundler is free to pick the JSON.
 *
 * Reach for these values only where a class name cannot go: the status bar,
 * a map style, an SVG stroke, a navigator option. Everything else styles with
 * NativeWind classes (docs/design/design-system.md).
 */
import raw from './design-tokens.json';

export type ColorScheme = 'light' | 'dark';

/** Semantic colour roles. Identical in both schemes — only the values differ. */
export type ColorRole = keyof typeof raw.color.light;

export type TypographyRole = keyof typeof raw.typography.scale;

export const space = raw.space;
export const radius = raw.radius;
export const size = raw.size;
export const icon = raw.icon;
export const typography = raw.typography;

export const colors: Record<ColorScheme, Record<ColorRole, string>> = raw.color;

/** Resolve one semantic role for a scheme. */
export function color(scheme: ColorScheme, role: ColorRole): string {
  return colors[scheme][role];
}

/**
 * `#rrggbb` -> `"r g b"`, the space-separated channel form Tailwind needs for
 * `rgb(var(--x) / <alpha-value>)`. Exported so the Tailwind config and the
 * contrast test agree on one implementation.
 */
export function hexToChannels(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export const tokens = raw;
