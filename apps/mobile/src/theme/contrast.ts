/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * This exists so the palette's legibility is a *test*, not a claim. A token
 * change that drops a text pair below 4.5:1 fails CI instead of shipping.
 * Reference: WCAG 2.1 §1.4.3 (contrast minimum) and §1.4.11 (non-text contrast).
 */

/** WCAG 2.1 relative luminance of an `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Contrast ratio between two `#rrggbb` colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
