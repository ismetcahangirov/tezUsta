/**
 * Join class names, dropping anything falsy.
 *
 * Deliberately not `clsx`: this is the whole of what we need, and every
 * dependency ships to the device (CLAUDE.md §10). Later wins, which is how
 * a `className` prop overrides a component's own defaults.
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
