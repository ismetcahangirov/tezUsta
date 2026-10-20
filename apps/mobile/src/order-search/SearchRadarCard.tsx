import type { OrderSearchProgress } from '@tezusta/types';
import { useEffect, useMemo } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';

import { Card, Text, type TextTone } from '../components';
import { useReduceMotion } from '../lib/useReduceMotion';
import { useTheme } from '../theme';
import { MapSurface } from '../tracking/map-surface';
import type { MapMarkerSpec, MapPoint, MapRingSpec } from '../tracking/map-surface.types';
import { RadarPulse } from './RadarPulse';
import { SEARCH_RADAR_COPY as copy } from './search-radar-copy';
import { radarIsSearchingVisibly, type RadarView } from './search-radar-policy';

/** Metres per degree of latitude, for framing the ring's four extremes. */
const METRES_PER_DEGREE = 111_320;

export interface SearchRadarCardProps {
  readonly view: RadarView;
  /**
   * The customer's own address, from the address list the order screen
   * already reads. `null` when it does not resolve, and the card is then a
   * sentence with no map — ADR-0035's "nothing to draw, no map" rule.
   */
  readonly centre: MapPoint | null;
}

/**
 * The search radar, under the status card while the order searches (issue
 * #398, [ADR-0055](../../../../docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 1–6): the address, a pulse, a ring at the radius the search has reached,
 * the coarse cells of the masters it reached, and one sentence with the count.
 *
 * **Presentational.** It is handed a view and a centre, so every state can be
 * reviewed in Storybook and tested without a store (`SearchRadar` wires it).
 *
 * **Nothing identifies a master**: the points are cell centres from the
 * server, all labelled alike, and the sentence is a count.
 */
export function SearchRadarCard({ view, centre }: SearchRadarCardProps): React.JSX.Element | null {
  const reduceMotion = useReduceMotion();

  if (view.kind === 'hidden') {
    return null;
  }

  const progress = view.kind === 'live' || view.kind === 'reconnecting' ? view.progress : null;
  const sentence = sentenceFor(view);

  return (
    <Card className="gap-3">
      <Text variant="body-strong">{copy.title}</Text>

      {centre !== null && view.kind !== 'error' && (
        <RadarMap
          centre={centre}
          progress={progress}
          pulsing={!reduceMotion && radarIsSearchingVisibly(view)}
        />
      )}

      <Caption message={sentence.message} tone={sentence.tone} />
    </Card>
  );
}

function sentenceFor(view: RadarView): { message: string; tone: TextTone } {
  switch (view.kind) {
    case 'loading':
    case 'hidden':
      return { message: copy.starting, tone: 'muted' };
    case 'error':
      return { message: copy.error, tone: 'muted' };
    case 'reconnecting':
      return { message: copy.reconnecting, tone: 'muted' };
    case 'live':
      return {
        message:
          view.progress.offeredCount === 0
            ? copy.reachedNobody
            : copy.reached(view.progress.offeredCount),
        tone: 'default',
      };
  }
}

/**
 * The map and the pulse over it.
 *
 * **Every prop the memoised `MapSurface` gets is stable between waves**: the
 * frame and the ring change when the radius does, the cells when the server's
 * list does (RTK Query keeps the same object for an equal answer), and the
 * pulse is a sibling the map never sees. So the native map re-renders once
 * per wave at most, never per animation frame.
 */
function RadarMap({
  centre,
  progress,
  pulsing,
}: {
  readonly centre: MapPoint;
  readonly progress: OrderSearchProgress | null;
  readonly pulsing: boolean;
}): React.JSX.Element {
  const { scheme } = useTheme();
  const { latitude, longitude } = centre;
  const radiusM = progress?.radiusM ?? null;
  const cellsFromServer = progress?.cells;

  const destination = useMemo<MapMarkerSpec>(
    () => ({ point: { latitude, longitude }, label: copy.addressMarker }),
    [latitude, longitude],
  );

  const ring = useMemo<MapRingSpec | null>(
    () => (radiusM === null ? null : { centre: { latitude, longitude }, radiusM }),
    [latitude, longitude, radiusM],
  );

  // The camera fits the ring by its four extremes, so it is framed once per
  // radius change; before the first read it centres on the address.
  const frame = useMemo<readonly MapPoint[]>(() => {
    if (radiusM === null) {
      return [{ latitude, longitude }];
    }
    const dLat = radiusM / METRES_PER_DEGREE;
    const dLng = radiusM / (METRES_PER_DEGREE * Math.cos((latitude * Math.PI) / 180));
    return [
      { latitude: latitude + dLat, longitude },
      { latitude: latitude - dLat, longitude },
      { latitude, longitude: longitude + dLng },
      { latitude, longitude: longitude - dLng },
    ];
  }, [latitude, longitude, radiusM]);

  const cells = useMemo<readonly MapMarkerSpec[]>(
    () => (cellsFromServer ?? []).map((point) => ({ point, label: copy.cellMarker })),
    [cellsFromServer],
  );

  return (
    <View className="relative">
      <MapSurface
        destination={destination}
        master={null}
        frame={frame}
        scheme={scheme}
        accessibilityLabel={copy.mapLabel}
        ring={ring}
        cells={cells}
      />
      <RadarPulse running={pulsing} />
    </View>
  );
}

/**
 * The count sentence, as a polite live region and, on iOS, announced — the
 * tracking card's pattern (ADR-0035 § 3), because VoiceOver has no live
 * regions. It changes once per wave at most, so it is not noise.
 */
function Caption({
  message,
  tone,
}: {
  readonly message: string;
  readonly tone: TextTone;
}): React.JSX.Element {
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
