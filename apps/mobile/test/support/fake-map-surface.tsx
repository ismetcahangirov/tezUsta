import { View } from 'react-native';

import type { MapSurfaceProps, MasterMarkerSpec } from '../../src/tracking/map-surface.types';
import { useGlidingPosition } from '../../src/tracking/useGlidingPosition';

/**
 * The map, replaced at its boundary for every test (issue #172).
 *
 * `react-native-maps` is a native view: under Jest there is nothing for it to
 * draw into, and `src/tracking/map-surface.tsx` is the only file that imports
 * it, exactly so this is the only file a test has to replace. `jest.setup.js`
 * installs it for the whole suite, the way a missing native module would
 * otherwise have to be mocked in every file that happens to render an order.
 *
 * **It renders what the map was told to draw, as things a customer would
 * perceive**: the map by its accessible name, each marker by its accessible
 * name, and — because "the marker moves" is the acceptance criterion — the
 * coordinate the master's marker is drawn at, as the marker's value. The
 * theme the map was asked for is the map's value, which is how a test asserts
 * the dark map without reaching into props.
 */
export function MapSurface({
  destination,
  master,
  scheme,
  accessibilityLabel,
}: MapSurfaceProps): React.JSX.Element {
  return (
    <View accessible accessibilityLabel={accessibilityLabel} accessibilityValue={{ text: scheme }}>
      {destination !== null && (
        <View
          accessible
          accessibilityLabel={destination.label}
          accessibilityValue={{ text: pointText(destination.point) }}
        />
      )}
      {master !== null && <FakeMasterMarker key={master.appearance} spec={master} />}
    </View>
  );
}

/**
 * The master's marker, keeping the surface's contract (`MapSurfaceProps.master`):
 * it glides to the reported point while live, and is placed on it otherwise,
 * using the same hook the real adapter uses and the same remount on a change of
 * appearance. So "the marker moves" is asserted in these suites without a map.
 */
function FakeMasterMarker({ spec }: { readonly spec: MasterMarkerSpec }): React.JSX.Element {
  const drawn = useGlidingPosition(spec.point, spec.appearance === 'live') ?? spec.point;
  return (
    <View
      accessible
      accessibilityLabel={spec.label}
      accessibilityValue={{ text: pointText(drawn) }}
    />
  );
}

export function pointText(point: { latitude: number; longitude: number }): string {
  return `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
}

/**
 * The value an element announces — a marker's coordinate, the map's theme.
 * Typed here once so the suites do not each read an untyped `props` bag.
 */
export function valueOf(element: { readonly props: object }): string | undefined {
  return (element.props as { accessibilityValue?: { text?: string } }).accessibilityValue?.text;
}
