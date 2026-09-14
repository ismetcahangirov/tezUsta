import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '../lib/cn';

/** Matches the keys of `typography.scale` in design-tokens.json. */
export type TextVariant = 'display' | 'h1' | 'h2' | 'body' | 'body-strong' | 'caption' | 'footnote';

export type TextTone =
  'default' | 'muted' | 'danger' | 'accent' | 'on-inverse' | 'on-accent' | 'on-danger';

/**
 * Class strings are written out rather than composed, because Tailwind only
 * sees literals when it scans the source. A generated `text-${variant}` would
 * produce no CSS at all.
 */
const VARIANT_CLASS: Record<TextVariant, string> = {
  display: 'text-display font-bold',
  h1: 'text-h1 font-bold',
  h2: 'text-h2 font-bold',
  body: 'text-body font-regular',
  'body-strong': 'text-body-strong font-bold',
  caption: 'text-caption font-regular',
  footnote: 'text-footnote font-regular',
};

const TONE_CLASS: Record<TextTone, string> = {
  default: 'text-text',
  muted: 'text-text-muted',
  danger: 'text-danger',
  // Lime type is legible on the inverse surface only — never on a light
  // background. docs/design/design-system.md §"The accent rule".
  accent: 'text-accent',
  'on-inverse': 'text-on-inverse',
  'on-accent': 'text-on-accent',
  'on-danger': 'text-on-danger',
};

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
}

/**
 * Every piece of type in the app goes through this component. That is what
 * keeps the type scale a scale instead of a suggestion.
 */
export function Text({
  variant = 'body',
  tone = 'default',
  className,
  ...rest
}: TextProps): React.JSX.Element {
  return <RNText className={cn(VARIANT_CLASS[variant], TONE_CLASS[tone], className)} {...rest} />;
}

export const TEXT_VARIANTS = Object.keys(VARIANT_CLASS) as TextVariant[];
export const TEXT_TONES = Object.keys(TONE_CLASS) as TextTone[];
