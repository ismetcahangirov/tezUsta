import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { FixedScheme } from '../theme';
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
 * A toggle's two states on the call surface (ADR-0041 § 2): off is a hairline
 * ring with a light icon, on is a solid fill with a dark icon — and `selected`
 * announces it, so the state is never carried by fill alone. Pinned to the
 * call surface's fixed scheme, as the call screen is.
 */
export const ToggleOnInverse: Story = {
  render: () => (
    <FixedScheme scheme="light" className="flex-row gap-3 rounded-md bg-inverse-surface p-4">
      <IconButton
        accessibilityLabel="Söndürülüb"
        variant="inverse-outline"
        selected={false}
        icon={<SettingsIcon tone="on-inverse" />}
      />
      <IconButton
        accessibilityLabel="Yandırılıb"
        variant="on-inverse"
        selected
        icon={<SettingsIcon tone="inverse-surface" />}
      />
    </FixedScheme>
  ),
};
