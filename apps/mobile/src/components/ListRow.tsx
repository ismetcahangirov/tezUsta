import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { cn } from '../lib/cn';
import { ProgressBar } from './ProgressBar';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  /**
   * How many lines the title may occupy before it is truncated. Unset, it
   * wraps for as long as it needs to — which is right for a label and wrong
   * for a customer's own two-thousand-character problem description.
   */
  titleNumberOfLines?: number;
  subtitle?: string;
  /** Renders the square-ended progress bar under the title, as in the reference. */
  progress?: { value: number; max: number };
  /** Trailing controls — typically an IconButton chevron. */
  trailing?: ReactNode;
  onPress?: () => void;
  /**
   * What a screen reader says for a pressable row. Defaults to the title;
   * set it when the trailing content carries meaning the title does not — an
   * unread count, say — because the row is announced as one control.
   */
  accessibilityLabel?: string;
  className?: string;
}

/**
 * The mission-list row: title, optional progress, trailing action. No borders —
 * spacing does the separating, which is what keeps a long list calm.
 */
export function ListRow({
  title,
  titleNumberOfLines,
  subtitle,
  progress,
  trailing,
  onPress,
  accessibilityLabel,
  className,
}: ListRowProps): React.JSX.Element {
  const content = (
    <>
      <View className="flex-1 gap-2 pr-4">
        <Text variant="body-strong" numberOfLines={titleNumberOfLines}>
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        )}
        {progress !== undefined && (
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <ProgressBar accessibilityLabel={title} value={progress.value} max={progress.max} />
            </View>
            <Text variant="caption">{`${progress.value}/${progress.max}`}</Text>
          </View>
        )}
      </View>
      {trailing}
    </>
  );

  const rowClass = cn('flex-row items-center py-4', className);

  if (onPress === undefined) {
    return <View className={rowClass}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      className={cn(rowClass, 'active:opacity-80')}
    >
      {content}
    </Pressable>
  );
}
