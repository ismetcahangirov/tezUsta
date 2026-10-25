import { useMemo } from 'react';
import { View } from 'react-native';

import { Card, Text } from '../components';
import { useTheme } from '../theme';
import { MapSurface } from '../tracking/map-surface';
import type { MapPoint } from '../tracking/map-surface.types';
import { MASTER_JOBS_COPY } from './master-jobs-copy';

const copy = MASTER_JOBS_COPY.map;

export interface JobMapCardProps {
  /** The customer's address on the job, which the master received at accept. */
  readonly destination: MapPoint;
  /** This phone's own position (`useOwnPosition`), `null` before a fix. */
  readonly position: MapPoint | null;
}

/**
 * Where the job is, drawn inside the app on the master's job screen
 * ([ADR-0062](../../../../docs/decisions/ADR-0062-master-job-map.md)).
 *
 * The same `MapSurface` the customer's tracking card uses (ADR-0035), so the
 * vendor stays behind one file and the markers are the ones already accepted
 * as interim art. Turn-by-turn stays with the maps app: the "Xəritədə aç"
 * button beside the address still hands the trip to Google Maps.
 *
 * Without a position the map frames the address alone and a caption says why
 * the master's own marker is missing, in words rather than by its absence.
 */
export function JobMapCard({ destination, position }: JobMapCardProps): React.JSX.Element {
  const { scheme } = useTheme();

  // Memoised so the surface (itself memoised) re-renders only when a point moves.
  const frame = useMemo(
    () => (position === null ? [destination] : [destination, position]),
    [destination, position],
  );
  const destinationMarker = useMemo(
    () => ({ point: destination, label: copy.destinationMarker }),
    [destination],
  );
  const selfMarker = useMemo(
    () =>
      position === null
        ? null
        : { point: position, label: copy.selfMarker, appearance: 'live' as const },
    [position],
  );

  return (
    <Card className="gap-2">
      <MapSurface
        scheme={scheme}
        accessibilityLabel={copy.label}
        frame={frame}
        destination={destinationMarker}
        master={selfMarker}
      />
      {position === null && (
        <View>
          <Text variant="caption" tone="muted">
            {copy.noPosition}
          </Text>
        </View>
      )}
    </Card>
  );
}
