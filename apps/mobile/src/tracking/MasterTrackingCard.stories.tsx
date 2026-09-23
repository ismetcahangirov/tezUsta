import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Text } from '../components';
import { MasterTrackingCard } from './MasterTrackingCard';
import type { TrackingView } from './tracking-policy';

const HOME = { latitude: 40.377, longitude: 49.892 };
const MASTER = { latitude: 40.4, longitude: 49.8 };

const meta = {
  title: 'Tracking/MasterTrackingCard',
  component: MasterTrackingCard,
  args: { view: { kind: 'live', position: MASTER }, destination: HOME },
} satisfies Meta<typeof MasterTrackingCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * Every state the card can be in, side by side — the review ADR-0035 asks for
 * before the layout is accepted. The map is the web stand-in
 * (`map-surface.web.tsx`): Storybook cannot draw a native map, so it lists the
 * markers the map would be told to draw, in the tokens it would draw them in.
 */
const STATES: readonly { name: string; view: TrackingView }[] = [
  { name: 'Live', view: { kind: 'live', position: MASTER } },
  { name: 'Stale', view: { kind: 'stale', position: MASTER } },
  { name: 'Reconnecting, with a last point', view: { kind: 'reconnecting', position: MASTER } },
  { name: 'Reconnecting, never had a point', view: { kind: 'reconnecting', position: null } },
  { name: 'No position yet', view: { kind: 'absent' } },
];

export const EveryState: Story = {
  render: () => (
    <View className="gap-6">
      {STATES.map((state) => (
        <View key={state.name} className="gap-2">
          <Text variant="caption" tone="muted">
            {state.name}
          </Text>
          <MasterTrackingCard view={state.view} destination={HOME} />
        </View>
      ))}
    </View>
  ),
};
