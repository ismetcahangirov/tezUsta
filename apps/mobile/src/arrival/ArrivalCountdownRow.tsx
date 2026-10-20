import type { ArrivalPromise } from '@tezusta/types';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, View } from 'react-native';

import { Text } from '../components';
import { ARRIVAL_COPY } from './arrival-copy';
import { useArrivalCountdown, type ArrivalCountdown } from './useArrivalCountdown';

export interface ArrivalCountdownRowProps {
  readonly promise: ArrivalPromise | null;
  /** Whose screen it is: the words differ, and so does the late tone. */
  readonly viewer: 'customer' | 'master';
  /** False while the screen is not focused; the countdown stops ticking. */
  readonly active?: boolean;
}

/**
 * The promised arrival as one row of text (issue #399, ADR-0055 § 12): the
 * clock time and the time left, then "late by N min" once it has passed.
 *
 * **Its own component so that a tick re-renders this line and nothing
 * else.** On the customer's tracking card it sits beside the native map, and a
 * once-a-second render of the whole card would reach it.
 *
 * - **The master's late state is `danger`**, because the promise is addressed
 *   to them. The customer's is the ordinary text tone: they are informed, not
 *   alarmed, and the closed palette has no `warning` to put between the two.
 * - **Not a live region**: it would speak every second. The change to late is
 *   announced once, naming the state and no number of minutes (ADR-0055 § 7,
 *   the Maps terms on speaking driving times).
 */
export function ArrivalCountdownRow({
  promise,
  viewer,
  active = true,
}: ArrivalCountdownRowProps): React.JSX.Element {
  const countdown = useArrivalCountdown(promise, active);
  const copy = ARRIVAL_COPY[viewer];

  const wasLate = useRef(countdown.state === 'late');
  useEffect(() => {
    const late = countdown.state === 'late';
    if (late && !wasLate.current) {
      AccessibilityInfo.announceForAccessibility(copy.lateAnnouncement);
    }
    wasLate.current = late;
  }, [countdown.state, copy.lateAnnouncement]);

  const line = linesFor(countdown, viewer);

  return (
    <View className="gap-1" testID="arrival-countdown">
      <Text
        variant="body-strong"
        tone={countdown.state === 'late' && viewer === 'master' ? 'danger' : 'default'}
      >
        {line.headline}
      </Text>
      {line.detail !== null && (
        <Text variant="caption" tone="muted">
          {line.detail}
        </Text>
      )}
    </View>
  );
}

function linesFor(
  countdown: ArrivalCountdown,
  viewer: 'customer' | 'master',
): { headline: string; detail: string | null } {
  const copy = ARRIVAL_COPY[viewer];
  const clock = countdown.clockTime ?? '';
  const by =
    viewer === 'customer'
      ? ARRIVAL_COPY.customer.arrivingBy(clock)
      : ARRIVAL_COPY.master.beThereBy(clock);

  switch (countdown.state) {
    case 'pending':
      return { headline: copy.pending, detail: null };
    case 'late':
      return { headline: copy.late(countdown.lateByMinutes), detail: by };
    case 'counting':
      return {
        headline:
          countdown.minutesLeft === null
            ? copy.underMinute
            : copy.minutesLeft(countdown.minutesLeft),
        detail: by,
      };
  }
}
