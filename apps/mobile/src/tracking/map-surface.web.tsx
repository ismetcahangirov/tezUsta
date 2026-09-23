import { View } from 'react-native';

import { Text } from '../components';
import { cn } from '../lib/cn';
import type { MapSurfaceProps } from './map-surface.types';

/**
 * The web stand-in for `map-surface.tsx` (issue #172).
 *
 * `react-native-maps` has no web implementation — its own `MapView.web.ts` is
 * React Native Web's `UnimplementedView` — and its native components cannot be
 * bundled by Vite at all. Storybook runs on React Native Web
 * ([ADR-0012](../../../../docs/decisions/ADR-0012-component-workshop.md)), so
 * without this file every story that reaches the order screen would fail to
 * build. Vite and Metro both resolve `.web.tsx` ahead of `.tsx`
 * (`vite-plugin-rnw`'s extension list), which is the whole of the wiring.
 *
 * **It draws the same two markers with the same tokens**, in a list rather than
 * on a map, so a reviewer in Storybook sees exactly what the native map is
 * told: which markers exist, and whether the master's is live or stale. The
 * app ships no web build of the customer screens, so this never reaches a
 * customer.
 */
export function MapSurface({
  destination,
  master,
  accessibilityLabel,
}: MapSurfaceProps): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      className="aspect-square w-full justify-end gap-2 rounded-md bg-surface-alt p-4"
    >
      {destination !== null && (
        <View className="flex-row items-center gap-2">
          <View className="h-avatar-sm w-avatar-sm items-center justify-center rounded-full border-2 border-surface bg-inverse-surface">
            <View className="h-2 w-2 rounded-full bg-on-inverse" />
          </View>
          <Text variant="caption">{destination.label}</Text>
        </View>
      )}
      {master !== null && (
        <View className="flex-row items-center gap-2">
          <View
            className={cn(
              'h-avatar-sm w-avatar-sm rounded-full border-2',
              master.appearance === 'live'
                ? 'border-on-accent bg-accent'
                : 'border-text-muted bg-surface-alt',
            )}
          />
          <Text variant="caption">{master.label}</Text>
        </View>
      )}
    </View>
  );
}
