import type { ColorScheme } from '../theme';

/**
 * The palette the photo viewer and the marks drawn over a photo use,
 * **whatever the device theme** (ADR-0054 § 3 and § 8, after ADR-0041 § 1).
 *
 * The light palette's `inverse-surface` / `on-inverse` are `#111` / `#fff`: a
 * photo is judged against black, and a light frame would change how it looks.
 * Over a photo, the dark palette's `on-inverse` (`#111`) on `overlay` (`#000`)
 * would be invisible. `contrast.test.ts` measures every pair against this.
 */
export const PHOTO_SURFACE_SCHEME: ColorScheme = 'light';

/**
 * The viewer's dots that are not the current photo: `on-inverse` at 40 %,
 * about 3.8:1 on `#111` (ADR-0054 § 3). Mirrors the literal `opacity-40` in
 * `MediaViewer.tsx` (a class must be a literal for Tailwind to see it); the
 * contrast test reads it.
 */
export const VIEWER_INACTIVE_DOT_OPACITY = 0.4;

/**
 * The stack mark's circle: `overlay` at 60 %, over whatever photo is under it
 * (ADR-0054 § 2). Mirrors `bg-overlay/60` in `MediaGrid.tsx`.
 */
export const STACK_MARK_SCRIM_OPACITY = 0.6;
