import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import type { OrderSearchProgress } from '@tezusta/types';
import { View } from 'react-native';

import { Text } from '../components';
import type { RadarView } from './search-radar-policy';
import { SearchRadarCard } from './SearchRadarCard';

const HOME = { latitude: 40.377, longitude: 49.892 };

const PROGRESS: OrderSearchProgress = {
  round: 3,
  radiusM: 5_800,
  maxRadiusM: 10_000,
  endsAt: '2026-10-20T10:03:00.000Z',
  offeredCount: 7,
  cells: [
    { latitude: 40.3775, longitude: 49.8917 },
    { latitude: 40.3925, longitude: 49.8851 },
    { latitude: 40.3625, longitude: 49.9048 },
  ],
};

const meta = {
  title: 'Order search/SearchRadarCard',
  component: SearchRadarCard,
  args: { view: { kind: 'live', progress: PROGRESS }, centre: HOME },
} satisfies Meta<typeof SearchRadarCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * Every state, side by side, for the owner's review (ADR-0055 lists the
 * motion, colours and copy as interim). The map is the web stand-in: it lists
 * the ring's radius and the cells the native map would draw. The pulse runs
 * here as it does on a phone, unless the browser asks for reduced motion.
 */
const STATES: readonly { name: string; view: RadarView; centre?: typeof HOME | null }[] = [
  { name: 'Starting, nothing read yet', view: { kind: 'loading' } },
  { name: 'Live, three cells', view: { kind: 'live', progress: PROGRESS } },
  {
    name: 'Live, reached nobody yet',
    view: { kind: 'live', progress: { ...PROGRESS, offeredCount: 0, cells: [] } },
  },
  { name: 'Reconnecting, with the last read', view: { kind: 'reconnecting', progress: PROGRESS } },
  { name: 'The read failed', view: { kind: 'error' } },
  { name: 'No address to centre on', view: { kind: 'live', progress: PROGRESS }, centre: null },
];

export const EveryState: Story = {
  render: () => (
    <View className="gap-6">
      {STATES.map((state) => (
        <View key={state.name} className="gap-2">
          <Text variant="caption" tone="muted">
            {state.name}
          </Text>
          <SearchRadarCard
            view={state.view}
            centre={state.centre === undefined ? HOME : state.centre}
          />
        </View>
      ))}
    </View>
  ),
};
