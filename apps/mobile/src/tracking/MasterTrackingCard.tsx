import { useEffect, useMemo } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';

import { Card, Text, type TextTone } from '../components';
import { useTheme } from '../theme';
import { MapSurface } from './map-surface';
import type { MapPoint } from './map-surface.types';
import { TRACKING_COPY as copy } from './tracking-copy';
import type { TrackingView } from './tracking-policy';

export interface MasterTrackingCardProps {
  readonly view: TrackingView;
  /**
   * The customer's own address for this order, from the address list the
   * order screen already reads — never from the order or the socket. `null`
   * when it does not resolve (a deleted address, a list still loading), and
   * the map then frames the master alone.
   */
  readonly destination: MapPoint | null;
}

/**
 * Where the master is, below the status card on the customer's order screen
 * ([ADR-0035](../../../../docs/decisions/ADR-0035-customer-tracking-map.md),
 * issue #172).
 *
 * **A card under the status card, not a map behind the screen.** The status
 * card stays the first thing on the screen, as ADR-0029 settled; the map adds
 * the one thing it could not say — how far away — and disappears when that
 * stops being a question.
 *
 * **No position, no map.** With nothing to draw but the customer's own
 * address, a native map view is memory and GPU spent on a picture of a place
 * the customer is standing in. The card says plainly that there is no
 * position yet, and mounts the map when the first one arrives.
 *
 * **Every state is written, not coloured.** Live, stale and reconnecting each
 * carry a sentence; the marker's colour repeats what the sentence says and is
 * never the only carrier of it (`design-system.md` § Status).
 */
export function MasterTrackingCard({
  view,
  destination,
}: MasterTrackingCardProps): React.JSX.Element | null {
  if (view.kind === 'hidden') {
    return null;
  }

  const position = view.kind === 'absent' ? null : view.position;

  return (
    <Card className="gap-3">
      <Text variant="body-strong">{copy.title}</Text>

      {position === null ? (
        <View className="gap-1">
          {view.kind === 'reconnecting' ? (
            <Caption message={copy.reconnecting} tone="muted" />
          ) : (
            <>
              <Text variant="body">{copy.absentTitle}</Text>
              <Text variant="caption" tone="muted">
                {copy.absentDescription}
              </Text>
            </>
          )}
        </View>
      ) : (
        <TrackingMap
          position={position}
          live={view.kind === 'live'}
          destination={destination}
          caption={
            view.kind === 'live'
              ? copy.live
              : view.kind === 'stale'
                ? copy.stale
                : copy.reconnecting
          }
        />
      )}
    </Card>
  );
}

interface TrackingMapProps {
  readonly position: MapPoint;
  readonly live: boolean;
  readonly destination: MapPoint | null;
  readonly caption: string;
}

function TrackingMap({
  position,
  live,
  destination,
  caption,
}: TrackingMapProps): React.JSX.Element {
  const { scheme } = useTheme();

  /**
   * Every prop memoised, so `MapSurface` (itself memoised) re-renders only when
   * a report arrives, the state changes or the theme does. The glide between
   * reports runs inside the surface's marker, not here.
   */
  const frame = useMemo(
    () => (destination === null ? [position] : [destination, position]),
    [destination, position],
  );
  const destinationMarker = useMemo(
    () => (destination === null ? null : { point: destination, label: copy.destinationMarker }),
    [destination],
  );
  const masterMarker = useMemo(
    () => ({
      point: position,
      label: live ? copy.masterMarker : copy.masterMarkerStale,
      appearance: live ? ('live' as const) : ('stale' as const),
    }),
    [position, live],
  );

  return (
    <View className="gap-2">
      <MapSurface
        scheme={scheme}
        accessibilityLabel={copy.mapLabel}
        frame={frame}
        destination={destinationMarker}
        master={masterMarker}
      />
      <Caption message={caption} tone={live ? 'default' : 'muted'} />
    </View>
  );
}

/**
 * The line that names the state, announced when it changes so a screen-reader
 * user hears "stale" or "reconnecting" when it happens rather than only if
 * they return to it.
 *
 * Two mechanisms, one per platform, as `Banner` documents: a polite live region
 * is TalkBack's, and VoiceOver has no live regions, so iOS is told explicitly.
 * Only iOS — on Android the live region already speaks, and calling both would
 * read every change twice.
 */
function Caption({ message, tone }: { readonly message: string; readonly tone: TextTone }) {
  useEffect(() => {
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  return (
    <View accessibilityLiveRegion="polite">
      <Text variant="caption" tone={tone}>
        {message}
      </Text>
    </View>
  );
}
