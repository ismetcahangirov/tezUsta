import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '../lib/cn';
import { typography } from '../theme/tokens';

/** Matches the keys of `typography.scale` in design-tokens.json. */
export type TextVariant = 'display' | 'h1' | 'h2' | 'body' | 'body-strong' | 'caption' | 'footnote';

export type TextTone = 'default' | 'muted' | 'danger' | 'on-inverse' | 'on-accent' | 'on-danger';

/**
 * Class strings are written out rather than composed, because Tailwind only
 * sees literals when it scans the source. A generated `text-${variant}` would
 * produce no CSS at all.
 */
const SIZE_CLASS: Record<TextVariant, string> = {
  display: 'text-display',
  h1: 'text-h1',
  h2: 'text-h2',
  body: 'text-body',
  'body-strong': 'text-body-strong',
  caption: 'text-caption',
  footnote: 'text-footnote',
};

/**
 * Weight and slant both come from the family, because each face is its own
 * file. Choosing one class here, rather than layering `font-italic` over
 * `font-bold`, keeps two rules from competing for the same `fontFamily`.
 */
const FAMILY_CLASS: Record<'regular' | 'bold', { upright: string; italic: string }> = {
  regular: { upright: 'font-regular', italic: 'font-italic' },
  bold: { upright: 'font-bold', italic: 'font-bold-italic' },
};

const TONE_CLASS: Record<TextTone, string> = {
  default: 'text-text',
  muted: 'text-text-muted',
  danger: 'text-danger',
  'on-inverse': 'text-on-inverse',
  'on-accent': 'text-on-accent',
  'on-danger': 'text-on-danger',
};

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  italic?: boolean;
}

/**
 * Every piece of type in the app goes through this component. That is what
 * keeps the type scale a scale instead of a suggestion.
 */
export function Text({
  variant = 'body',
  tone = 'default',
  italic = false,
  className,
  ...rest
}: TextProps): React.JSX.Element {
  const family = FAMILY_CLASS[typography.scale[variant].weight === 'bold' ? 'bold' : 'regular'];

  return (
    <RNText
      className={cn(
        SIZE_CLASS[variant],
        italic ? family.italic : family.upright,
        TONE_CLASS[tone],
        className,
      )}
      {...rest}
    />
  );
}

export const TEXT_VARIANTS = Object.keys(SIZE_CLASS) as TextVariant[];
export const TEXT_TONES = Object.keys(TONE_CLASS) as TextTone[];
