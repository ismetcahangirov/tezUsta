import { memo, useEffect, useRef, useState } from 'react';
import { PixelRatio, Platform, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type Provider, type Region } from 'react-native-maps';

import { cn } from '../lib/cn';
import { space } from '../theme';
import type { MapMarkerSpec, MapSurfaceProps, MasterMarkerSpec } from './map-surface.types';

/**
 * The only file in the app that imports `react-native-maps` (issue #172,
 * [ADR-0035](../../../../docs/decisions/ADR-0035-customer-tracking-map.md)).
 *
 * **It draws; it decides nothing.** Which statuses show a map, when a point is
 * stale, and whether the marker glides are all `tracking-policy.ts`'s; by the
 * time a prop reaches this file it is a coordinate and an appearance. That is
 * what lets every one of those rules be tested with this file replaced by a
 * stand-in (`test/support/fake-map-surface.tsx`), and what makes the web
 * stand-in (`map-surface.web.tsx`) a complete implementation rather than a
 * fork.
 */

/**
 * Google Maps on both platforms, as ADR-0004 requires — **when the build has a
 * key for it.**
 *
 * The `react-native-maps` config plugin installs the Google Maps SDK on iOS
 * only when `iosGoogleMapsApiKey` is set (`plugin/build/ios.js`), and asking
 * for `PROVIDER_GOOGLE` without that SDK draws an error instead of a map. So a
 * development build made without the key gets Apple Maps rather than a broken
 * view. A release build must set the key; `.env.example` says so, and ADR-0035
 * records the exception as development-only.
 *
 * Android has no such fork: Google is its only provider, and without a key it
 * draws blank tiles, which is the honest failure for a misconfigured build.
 *
 * Read by name rather than through a helper because Metro inlines
 * `process.env.EXPO_PUBLIC_*` only where it is written out literally.
 */
const PROVIDER: Provider =
  Platform.OS === 'ios' && (process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY ?? '') === ''
    ? // `undefined` is the platform default. Written out rather than as the
      // library's `PROVIDER_DEFAULT`, which is exported as `any`.
      undefined
    : PROVIDER_GOOGLE;

/**
 * The margin the camera keeps around the points it frames.
 *
 * A spacing token, and converted on Android: `fitToCoordinates` hands
 * `edgePadding` to `GoogleMap.setPadding` as raw pixels there
 * (`android/src/main/java/com/rnmaps/maps/MapView.java`, `appendMapPadding`,
 * `react-native-maps@1.27.2`), while iOS reads points. Unconverted, the padding
 * would be a third of its size on a 3x Android screen and put the marker under
 * the card's rounded corner.
 */
const FRAME_PADDING =
  Platform.OS === 'android' ? PixelRatio.getPixelSizeForLayoutSize(space[12]) : space[12];

const EDGE_PADDING = {
  top: FRAME_PADDING,
  right: FRAME_PADDING,
  bottom: FRAME_PADDING,
  left: FRAME_PADDING,
};

/** A street-level view of one point: enough to recognise the block. */
const SINGLE_POINT_ZOOM = 15;
/** The span of the first frame, before the camera has been asked to fit. */
const INITIAL_SPAN_DEGREES = 0.02;
const CAMERA_MS = 600;

export function MapSurface({
  destination,
  master,
  frame,
  scheme,
  accessibilityLabel,
}: MapSurfaceProps): React.JSX.Element {
  const mapRef = useRef<MapView>(null);
  const [ready, setReady] = useState(false);

  /**
   * The camera follows the **reports**, not the marker. `frame` changes once
   * per received point, so the camera moves once per point, natively and
   * animated; the gliding marker, which changes four times a second, is not in
   * it. Re-fitting on every tick would put the camera and the marker in a race
   * for the same frames on a device that has few to spare.
   */
  useEffect(() => {
    const map = mapRef.current;
    const [first] = frame;
    if (!ready || map === null || first === undefined) {
      return;
    }

    if (frame.length === 1) {
      map.animateCamera({ center: first, zoom: SINGLE_POINT_ZOOM }, { duration: CAMERA_MS });
    } else {
      map.fitToCoordinates([...frame], { edgePadding: EDGE_PADDING, animated: true });
    }
  }, [ready, frame]);

  const [initial] = frame;
  const initialRegion: { initialRegion?: Region } =
    initial === undefined
      ? {}
      : {
          initialRegion: {
            ...initial,
            latitudeDelta: INITIAL_SPAN_DEGREES,
            longitudeDelta: INITIAL_SPAN_DEGREES,
          },
        };

  return (
    <View className="aspect-square w-full overflow-hidden rounded-md">
      <MapView
        ref={mapRef}
        provider={PROVIDER}
        style={{ flex: 1 }}
        accessibilityLabel={accessibilityLabel}
        {...initialRegion}
        onMapReady={() => {
          setReady(true);
        }}
        /**
         * The platform's own light or dark map, following the app's theme.
         * The owner's map style JSON replaces this when it exists (ADR-0011);
         * until then it is the one theming lever that needs no invented
         * colour.
         */
        userInterfaceStyle={scheme}
        /**
         * A picture, not a control. The map sits inside the order screen's
         * `ScrollView`, and a pannable map there steals the scroll gesture from
         * the rest of the order. The camera frames what matters by itself.
         */
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
        moveOnMarkerPress={false}
        showsPointsOfInterests={false}
        showsCompass={false}
        showsMyLocationButton={false}
        showsUserLocation={false}
      >
        {destination !== null && <DestinationMarker spec={destination} />}
        {master !== null && <MasterMarker spec={master} />}
      </MapView>
    </View>
  );
}

/**
 * Whether a custom-view marker should keep re-snapshotting its children.
 *
 * On Android a marker with children is drawn as a bitmap, and
 * `tracksViewChanges` re-draws that bitmap on every frame — the most common
 * cause of a stuttering map in `react-native-maps`. It is on only until the
 * child has laid out once, which is what gives the snapshot something to draw,
 * and off from then on. An appearance change remounts the marker (see the
 * `key` in {@link MasterMarker}) rather than re-enabling it.
 */
function useSnapshotOnce(): { tracks: boolean; onLayout: () => void } {
  const [tracks, setTracks] = useState(true);
  return {
    tracks,
    onLayout: () => {
      setTracks(false);
    },
  };
}

const DestinationMarker = memo(function DestinationMarker({
  spec,
}: {
  readonly spec: MapMarkerSpec;
}): React.JSX.Element {
  const snapshot = useSnapshotOnce();

  return (
    <Marker
      coordinate={spec.point}
      accessibilityLabel={spec.label}
      tracksViewChanges={snapshot.tracks}
      anchor={{ x: 0.5, y: 0.5 }}
    >
      <View
        onLayout={snapshot.onLayout}
        className="h-avatar-sm w-avatar-sm items-center justify-center rounded-full border-2 border-surface bg-inverse-surface"
      >
        <View className="h-2 w-2 rounded-full bg-on-inverse" />
      </View>
    </Marker>
  );
});

function MasterMarker({ spec }: { readonly spec: MasterMarkerSpec }): React.JSX.Element {
  // Keyed on the appearance so a change of colour is a fresh snapshot rather
  // than a bitmap that keeps showing the old one.
  return <MasterMarkerBody key={spec.appearance} spec={spec} />;
}

function MasterMarkerBody({ spec }: { readonly spec: MasterMarkerSpec }): React.JSX.Element {
  const snapshot = useSnapshotOnce();
  const live = spec.appearance === 'live';

  return (
    <Marker
      coordinate={spec.point}
      accessibilityLabel={spec.label}
      tracksViewChanges={snapshot.tracks}
      anchor={{ x: 0.5, y: 0.5 }}
    >
      <View
        onLayout={snapshot.onLayout}
        className={cn(
          'h-avatar-sm w-avatar-sm rounded-full border-2',
          live ? 'border-on-accent bg-accent' : 'border-text-muted bg-surface-alt',
        )}
      />
    </Marker>
  );
}
