import { View } from 'react-native';

import { cn } from '../lib/cn';
import { Text, type TextTone } from './Text';

export type BadgeTone = 'accent' | 'neutral' | 'danger' | 'inverse';

const CONTAINER_CLASS: Record<BadgeTone, string> = {
  accent: 'bg-accent',
  neutral: 'bg-surface-alt',
  danger: 'bg-danger',
  inverse: 'bg-inverse-surface',
};

const LABEL_TONE: Record<BadgeTone, TextTone> = {
  accent: 'on-accent',
  neutral: 'default',
  danger: 'on-danger',
  inverse: 'on-inverse',
};

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  className?: string | undefined;
}

/** The small lime pill the reference uses to tag a section. */
export function Badge({ label, tone = 'neutral', className }: BadgeProps): React.JSX.Element {
  return (
    <View className={cn('self-start rounded-full px-3 py-1', CONTAINER_CLASS[tone], className)}>
      <Text variant="caption" tone={LABEL_TONE[tone]}>
        {label}
      </Text>
    </View>
  );
}
