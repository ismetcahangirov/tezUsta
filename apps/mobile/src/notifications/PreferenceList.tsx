import type { NotificationPreference } from '@tezusta/types';
import { View } from 'react-native';

import { ListRow } from '../components/ListRow';
import { SegmentedControl } from '../components/SegmentedControl';
import { StatusPill } from '../components/StatusPill';
import { categoryCopy, notificationsCopy } from './notifications-copy';

const copy = notificationsCopy.preferences;

export type PreferenceChoice = 'on' | 'off';

export interface PreferenceListProps {
  readonly preferences: readonly NotificationPreference[];
  /** A write is in flight; taps are ignored rather than queued. */
  readonly busy?: boolean;
  readonly onChoose: (category: string, choice: PreferenceChoice) => void;
}

/**
 * The categories themselves — presentational, holding no server state.
 *
 * Split from `NotificationPreferences` the way `AvailabilityToggle` is split
 * from `AvailabilityCard`: the thing with a visual worth reviewing gets a
 * story, and the thing that holds a query does not (ADR-0012).
 *
 * **There is no switch in the design system, and one is not invented here.**
 * The inventory is settled (ADR-0011) and has no toggle; `AvailabilityToggle`
 * met the same problem and answered it with `SegmentedControl`, so this does
 * the same rather than adding a control nobody chose.
 *
 * **A locked category gets no control at all**, not a greyed-out one. A
 * disabled style is a visual decision nobody has made, and the requirement is
 * that a mandatory category be *visible and explained* — a user who cannot
 * find "offers" in the list concludes the setting is missing rather than
 * deliberate. So it gets a pill and a sentence.
 */
export function PreferenceList({
  preferences,
  busy = false,
  onChoose,
}: PreferenceListProps): React.JSX.Element {
  return (
    <View className="gap-3">
      {preferences.map((preference) => (
        <PreferenceRow
          key={preference.category}
          preference={preference}
          busy={busy}
          onChoose={onChoose}
        />
      ))}
    </View>
  );
}

interface PreferenceRowProps {
  readonly preference: NotificationPreference;
  readonly busy: boolean;
  readonly onChoose: (category: string, choice: PreferenceChoice) => void;
}

function PreferenceRow({ preference, busy, onChoose }: PreferenceRowProps): React.JSX.Element {
  const { title, lockedReason } = categoryCopy(preference.category);
  const choice: PreferenceChoice = preference.enabled ? 'on' : 'off';

  if (!preference.changeable) {
    return (
      <ListRow
        title={title}
        // Spread rather than `subtitle={… : undefined}`: `exactOptionalPropertyTypes`
        // distinguishes "absent" from "present and undefined", and `ListRowProps`
        // means the first one.
        {...(lockedReason === '' ? {} : { subtitle: lockedReason })}
        trailing={<StatusPill status="active" label={copy.lockedPill} />}
      />
    );
  }

  return (
    <ListRow
      title={title}
      {...(lockedReason === '' ? {} : { subtitle: lockedReason })}
      trailing={
        // The label carries the current value, so a test — and a screen reader
        // — can read the state of a control whose selected segment is
        // otherwise only a colour.
        <View accessibilityLabel={`${title}: ${choice === 'on' ? copy.on : copy.off}`}>
          <SegmentedControl<PreferenceChoice>
            items={[
              { value: 'on', label: copy.on },
              { value: 'off', label: copy.off },
            ]}
            value={choice}
            onChange={(next) => {
              if (!busy) {
                onChoose(preference.category, next);
              }
            }}
          />
        </View>
      }
    />
  );
}
