import { Image, View } from 'react-native';

import { cn } from '../lib/cn';
import { Text, type TextVariant } from './Text';

export type AvatarSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-avatar-sm w-avatar-sm',
  md: 'h-avatar-md w-avatar-md',
  lg: 'h-avatar-lg w-avatar-lg',
};

const INITIALS_VARIANT: Record<AvatarSize, TextVariant> = {
  sm: 'footnote',
  md: 'caption',
  lg: 'h2',
};

export interface AvatarProps {
  /** The person's name. Drives both the fallback initials and the label. */
  name: string;
  uri?: string;
  size?: AvatarSize;
  className?: string;
}

/** First letters of the first two words, upper-cased. */
function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toLocaleUpperCase('az-AZ');
}

export function Avatar({ name, uri, size = 'md', className }: AvatarProps): React.JSX.Element {
  const shared = cn('items-center justify-center overflow-hidden rounded-full', SIZE_CLASS[size]);

  if (uri !== undefined) {
    return (
      <Image
        accessibilityRole="image"
        accessibilityLabel={name}
        source={{ uri }}
        className={cn(shared, className)}
      />
    );
  }

  return (
    <View accessible accessibilityLabel={name} className={cn(shared, 'bg-surface-alt', className)}>
      <Text variant={INITIALS_VARIANT[size]}>{initialsOf(name)}</Text>
    </View>
  );
}
