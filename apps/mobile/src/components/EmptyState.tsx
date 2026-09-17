import type { ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '../lib/cn';
import { Text } from './Text';

export interface EmptyStateProps {
  /** One short line saying what is not here. */
  title: string;
  /** Optional second line saying what to do about it. */
  description?: string;
  /** Typically a `Button` — a retry, or a way out. */
  action?: ReactNode;
  className?: string;
}

/**
 * The shape an empty list, a failed load, or a filtered-to-nothing result all
 * take.
 *
 * **Structure only.** `docs/design/design-system.md` §9 leaves the *content* of
 * an empty state — its words and its illustration — to the owner, so this
 * component takes both as props and invents neither. There is no default
 * title: a component that shipped with one would put words nobody chose in
 * front of a customer, and the absence of a default is what forces the caller
 * to decide.
 *
 * No illustration slot yet, for the same reason: the art does not exist, and a
 * slot for it would be an empty box in every state until it does.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <View className={cn('items-center gap-3 px-6 py-10', className)}>
      <Text variant="body-strong" className="text-center">
        {title}
      </Text>
      {description !== undefined && (
        <Text variant="caption" tone="muted" className="text-center">
          {description}
        </Text>
      )}
      {action !== undefined && <View className="pt-2">{action}</View>}
    </View>
  );
}
