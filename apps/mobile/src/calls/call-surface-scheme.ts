import type { ColorScheme } from '../theme';

/**
 * The palette the call surface is drawn from, **whatever the device theme**
 * ([ADR-0041](../../../../docs/decisions/ADR-0041-call-surface-fixed-appearance.md) § 1).
 *
 * The light palette's `inverse-surface` / `on-inverse` are `#111` / `#fff` —
 * the same pair as the dark palette's `bg` / `text` — and against `#111` lime
 * is legal as type and as a fill. Following the device instead would turn the
 * surface white in dark mode, where lime and the danger fill both fail.
 * `contrast.test.ts` checks every pair the surface uses against this palette.
 */
export const CALL_SURFACE_SCHEME: ColorScheme = 'light';

/**
 * How far the call surface mutes secondary type — the service name, and the
 * duration while reconnecting — as a fraction of `on-inverse` over the
 * surface. Mirrors the literal `opacity-80` class in `CallScreen.tsx` (a class
 * must be a literal for Tailwind to see it); the contrast test reads this.
 */
export const CALL_SURFACE_MUTED_OPACITY = 0.8;
