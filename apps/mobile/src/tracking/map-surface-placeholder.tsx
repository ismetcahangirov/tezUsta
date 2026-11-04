import { View } from 'react-native';

import { Text } from '../components';
import { cn } from '../lib/cn';
import type { MapSurfaceProps } from './map-surface.types';

/**
 * What a map surface draws when there is no map to draw.
 *
 * Two places need it:
 *
 * - **the web**, where `react-native-maps` has no implementation
 *   (`map-surface.web.tsx`);
 * - **an Android build made without a Google Maps key**, where the Maps SDK
 *   throws `API key not found` the moment a `MapView` mounts and takes the app
 *   down with it (#500). `map-surface.tsx` picks this instead.
 *
 * **It draws the same markers with the same tokens**, in a list rather than on
 * a map, so a reviewer in Storybook or a tester on a keyless build sees exactly
 * what the native map is told: which markers exist, and whether the master's
 * is live or stale. A release build sets the key, so this never reaches a
 * customer.
 */
export function MapSurfacePlaceholder({
  destination,
  master,
  accessibilityLabel,
  ring = null,
  cells = [],
}: MapSurfaceProps): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      testID="map-surface-placeholder"
      className="aspect-square w-full justify-end gap-2 rounded-md bg-surface-alt p-4"
    >
      {ring !== null && (
        <Text variant="caption" tone="muted">
          {`${String(Math.round(ring.radiusM / 100) / 10)} km`}
        </Text>
      )}
      {cells.map((cell) => (
        <View
          key={`${String(cell.point.latitude)},${String(cell.point.longitude)}`}
          className="flex-row items-center gap-2"
        >
          <View className="h-3 w-3 rounded-full border-2 border-text-muted bg-surface-alt" />
          <Text variant="caption">{cell.label}</Text>
        </View>
      ))}
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
