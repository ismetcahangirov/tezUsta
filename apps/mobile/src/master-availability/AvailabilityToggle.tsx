import type { MasterAvailability } from '@tezusta/types';
import { View } from 'react-native';

import { Banner } from '../components/Banner';
import { Card } from '../components/Card';
import { SegmentedControl } from '../components/SegmentedControl';
import { StatusPill } from '../components/StatusPill';
import { Text } from '../components/Text';
import { MASTER_AVAILABILITY_COPY as copy } from './master-availability-copy';

export type AvailabilityChoice = 'online' | 'offline';

export interface AvailabilityToggleProps {
  readonly availability: MasterAvailability;
  readonly onChange: (isAvailable: boolean) => void;
  readonly disabled?: boolean;
  /** A reason the master cannot go online, already resolved to a sentence. */
  readonly blockedReason?: string | undefined;
}

/**
 * The master's own picture of whether they are working.
 *
 * Presentational: it owns no server state and takes the whole
 * {@link MasterAvailability} as a prop, the way `CategoryList` takes its
 * categories. The screen above it holds the query.
 *
 * **The stale case is the reason this component is not a switch.** When the
 * stored intent says online and the server has not heard from the app inside
 * the presence window, those are two different facts and the master needs both
 * — `docs/product/master-flow.md`: "detect stale reporting and warn the master,
 * rather than silently showing them as active". A single on/off switch has
 * nowhere to put that, so the control shows the **choice** and the pill beside
 * it shows the **reality**, with a banner when they disagree.
 *
 * Every visual here comes from the supplied design system: `SegmentedControl`
 * (the same control `settings.tsx` uses for the role and theme choices),
 * `StatusPill`, `Banner`, `Card`. Nothing new is invented — ADR-0011 settles
 * the inventory and CLAUDE.md §17 leaves the rest to the owner.
 */
export function AvailabilityToggle({
  availability,
  onChange,
  disabled = false,
  blockedReason,
}: AvailabilityToggleProps): React.JSX.Element {
  const { isAvailable, isLive } = availability;

  // Intent and liveness disagree: the master believes they are working and the
  // server has stopped hearing from them. This is the only state with a
  // warning, and it is the one that costs a master money in silence.
  const isStale = isAvailable && !isLive;

  const choice: AvailabilityChoice = isAvailable ? 'online' : 'offline';

  return (
    <Card>
      <View className="gap-4">
        <View className="flex-row items-center justify-between">
          <Text variant="body-strong">{copy.title}</Text>
          <StatusPill
            // `pending` while stale rather than `active`: the pill must not
            // say "taking orders" when nothing is reaching this phone. It is
            // the neutral tone, and the label is what carries the meaning.
            status={isAvailable && isLive ? 'active' : isAvailable ? 'pending' : 'cancelled'}
            label={
              isAvailable && isLive
                ? copy.liveLabel
                : isAvailable
                  ? copy.staleTitle
                  : copy.offlineLabel
            }
          />
        </View>

        <SegmentedControl<AvailabilityChoice>
          items={[
            { value: 'offline', label: copy.offline },
            { value: 'online', label: copy.online },
          ]}
          value={choice}
          onChange={(next) => {
            if (disabled) {
              return;
            }
            onChange(next === 'online');
          }}
        />

        {isStale ? <Banner tone="danger" message={copy.staleDescription} /> : null}

        {blockedReason === undefined ? null : <Banner tone="neutral" message={blockedReason} />}
      </View>
    </Card>
  );
}
