import { forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';

/**
 * `react-native-maps`, as far as `src/tracking/map-surface.tsx` uses it, for
 * the one suite that tests that adapter (`map-surface.test.tsx`).
 *
 * Every prop the adapter passes is forwarded onto a plain `View`, so a test can
 * read what the map was asked to be; each marker is an accessible element with
 * its coordinate as its value. The camera is a pair of spies.
 */
type MapViewStubProps = ViewProps & { readonly onMapReady?: () => void };

interface MarkerStubProps {
  readonly children?: ReactNode;
  readonly coordinate?: unknown;
  readonly accessibilityLabel?: string;
}

export const camera = { fitToCoordinates: jest.fn(), animateCamera: jest.fn() };

/** How many times the stub `MapView` has rendered. Reset it in `beforeEach`. */
export const mapRenders = { count: 0 };

const MapView = forwardRef<typeof camera, MapViewStubProps>(function MapView(
  { children, onMapReady, ...rest },
  ref,
) {
  useImperativeHandle(ref, () => camera);
  mapRenders.count += 1;
  return (
    <View testID="vendor-map" {...rest} onLayout={onMapReady}>
      {children}
    </View>
  );
});

export function Marker({
  children,
  coordinate,
  accessibilityLabel,
}: MarkerStubProps): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: JSON.stringify(coordinate) }}
    >
      {children}
    </View>
  );
}

export const PROVIDER_DEFAULT = undefined;
export const PROVIDER_GOOGLE = 'google';

export default MapView;
