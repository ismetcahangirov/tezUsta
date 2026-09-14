import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { ChevronLeftIcon, CloseIcon, MapPinIcon, SettingsIcon } from './icons';
import { IconButton } from './IconButton';

const meta = {
  title: 'Components/IconButton',
  component: IconButton,
  args: {
    accessibilityLabel: 'Geri',
    icon: <ChevronLeftIcon tone="on-inverse" />,
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <View className="flex-row gap-3">
      <IconButton accessibilityLabel="Geri" icon={<ChevronLeftIcon tone="on-inverse" />} />
      <IconButton
        accessibilityLabel="Tənzimləmələr"
        variant="surface"
        icon={<SettingsIcon tone="text" />}
      />
      <IconButton
        accessibilityLabel="Xəritədə göstər"
        variant="accent"
        icon={<MapPinIcon tone="on-accent" />}
      />
      <IconButton accessibilityLabel="Bağla" variant="ghost" icon={<CloseIcon tone="text" />} />
      <IconButton accessibilityLabel="Sil" variant="danger" icon={<CloseIcon tone="on-danger" />} />
    </View>
  ),
};
