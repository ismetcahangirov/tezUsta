import { View, type ViewProps } from 'react-native';

import { cn } from '../lib/cn';

/**
 * The hairline the reference uses between detail rows. Decorative by design —
 * it separates, it does not carry meaning — so it is hidden from screen readers.
 */
export function Divider({ className, ...rest }: ViewProps): React.JSX.Element {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn('h-hairline w-full bg-border', className)}
      {...rest}
    />
  );
}
