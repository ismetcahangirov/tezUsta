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

/**
 * The two fills a toggle takes on the inverse call surface (ADR-0040 § 4):
 * `surface-alt` when off, `on-inverse` when on — and `selected` announces it,
 * so the state is never carried by colour alone.
 */
export const ToggleOnInverse: Story = {
  render: () => (
    <View className="flex-row gap-3 rounded-md bg-inverse-surface p-4">
      <IconButton
        accessibilityLabel="Söndürülüb"
        variant="surface-alt"
        selected={false}
        icon={<SettingsIcon tone="text" />}
      />
      <IconButton
        accessibilityLabel="Yandırılıb"
        variant="on-inverse"
        selected
        icon={<SettingsIcon tone="inverse-surface" />}
      />
    </View>
  ),
};
