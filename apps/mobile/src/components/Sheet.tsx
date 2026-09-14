import { View, type ViewProps } from 'react-native';

import { cn } from '../lib/cn';
import { Text } from './Text';

export interface SheetProps extends ViewProps {
  title?: string;
}

/**
 * The bottom sheet the reference anchors over the map: page background, `lg`
 * radius on the top corners only, generous padding.
 *
 * Presentation only — gesture handling and the backdrop belong to whatever
 * presents it, so this stays testable and carries no navigation dependency.
 */
export function Sheet({ title, children, className, ...rest }: SheetProps): React.JSX.Element {
  return (
    <View className={cn('w-full gap-4 rounded-t-lg bg-bg p-6', className)} {...rest}>
      {title !== undefined && (
        <Text variant="h1" accessibilityRole="header">
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}
