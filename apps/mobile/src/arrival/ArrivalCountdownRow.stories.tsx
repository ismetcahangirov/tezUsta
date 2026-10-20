import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import type { ArrivalPromise } from '@tezusta/types';
import { View } from 'react-native';

import { Card, Text } from '../components';
import { ArrivalCountdownRow } from './ArrivalCountdownRow';

/** A promise `seconds` from the moment the story renders. */
function inSeconds(seconds: number): ArrivalPromise {
  return {
    promisedAt: new Date(Date.now() + seconds * 1000).toISOString(),
    secondsRemaining: seconds,
    source: 'route',
  };
}

const meta = {
  title: 'Arrival/ArrivalCountdownRow',
  component: ArrivalCountdownRow,
  args: { promise: inSeconds(420), viewer: 'customer' },
} satisfies Meta<typeof ArrivalCountdownRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * Every state, for both parties, for the owner's review (ADR-0055 lists the
 * layout, typography and copy as interim). The countdowns are live: the
 * under-a-minute rows turn late while you watch.
 */
const STATES: readonly { name: string; promise: ArrivalPromise | null }[] = [
  { name: 'Calculating', promise: null },
  { name: 'Counting, 12 minutes', promise: inSeconds(720) },
  { name: 'Under a minute', promise: inSeconds(40) },
  { name: 'Late by 3 minutes', promise: inSeconds(-150) },
];

export const EveryState: Story = {
  render: () => (
    <View className="gap-6">
      {(['customer', 'master'] as const).map((viewer) => (
        <View key={viewer} className="gap-3">
          <Text variant="body-strong">{viewer}</Text>
          {STATES.map((state) => (
            <View key={state.name} className="gap-2">
              <Text variant="caption" tone="muted">
                {state.name}
              </Text>
              <Card>
                <ArrivalCountdownRow promise={state.promise} viewer={viewer} />
              </Card>
            </View>
          ))}
        </View>
      ))}
    </View>
  ),
};
