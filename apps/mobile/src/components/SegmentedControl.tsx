import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { cn } from '../lib/cn';
import { Text } from './Text';

export interface SegmentedControlItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  items: SegmentedControlItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Hide labels and show icons only, as the reference's Mission switcher does. */
  iconOnly?: boolean;
  className?: string;
}

/** The pill-in-a-pill switcher: light track, filled active segment. */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  iconOnly = false,
  className,
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <View
      accessibilityRole="tablist"
      className={cn('flex-row rounded-full bg-surface p-1', className)}
    >
      {items.map((item) => {
        const selected = item.value === value;

        return (
          <Pressable
            key={item.value}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected }}
            onPress={() => {
              onChange(item.value);
            }}
            className={cn(
              'h-control-sm flex-1 flex-row items-center justify-center gap-2 rounded-full',
              selected ? 'bg-inverse-surface' : 'bg-transparent',
            )}
          >
            {item.icon}
            {!iconOnly && (
              <Text variant="caption" tone={selected ? 'on-inverse' : 'muted'}>
                {item.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
