import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { useState } from 'react';
import { View } from 'react-native';

import { SegmentedControl } from './SegmentedControl';
import { Text } from './Text';

const ROLES = [
  { value: 'customer', label: 'Müştəri' },
  { value: 'master', label: 'Usta' },
];

const MISSION_FILTERS = [
  { value: 'all', label: 'Hamısı' },
  { value: 'active', label: 'Aktiv' },
  { value: 'done', label: 'Bitmiş' },
];

const meta = {
  title: 'Components/SegmentedControl',
  component: SegmentedControl,
  args: {
    items: ROLES,
    value: 'customer',
    onChange: () => undefined,
  },
} satisfies Meta<typeof SegmentedControl<string>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value);

    return <SegmentedControl {...args} value={value} onChange={setValue} />;
  },
};

export const ThreeSegments: Story = {
  args: { items: MISSION_FILTERS, value: 'active' },
  render: (args) => {
    const [value, setValue] = useState(args.value);

    return (
      <View className="gap-3">
        <SegmentedControl {...args} value={value} onChange={setValue} />
        <Text variant="caption" tone="muted">{`Seçilmiş: ${value}`}</Text>
      </View>
    );
  },
};
