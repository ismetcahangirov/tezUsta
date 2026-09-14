import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Button } from './Button';
import { MapPinIcon } from './icons';

const meta = {
  title: 'Components/Button',
  component: Button,
  args: {
    label: 'Sifarişi təsdiqlə',
    variant: 'primary',
    size: 'md',
  },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'accent', 'secondary', 'ghost', 'danger'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <View className="gap-3">
      <Button label="Sifarişi təsdiqlə" variant="primary" fullWidth />
      <Button label="Qiyməti qəbul et" variant="accent" fullWidth />
      <Button label="Başqa usta seç" variant="secondary" fullWidth />
      <Button label="Sonra" variant="ghost" fullWidth />
      <Button label="Sifarişi ləğv et" variant="danger" fullWidth />
    </View>
  ),
};

export const Sizes: Story = {
  render: () => (
    <View className="items-start gap-3">
      <Button label="Kiçik" size="sm" />
      <Button label="Orta" size="md" />
      <Button label="Böyük" size="lg" />
    </View>
  ),
};

export const WithIcon: Story = {
  args: { label: 'Xəritədə göstər', icon: <MapPinIcon tone="on-inverse" /> },
};

export const States: Story = {
  render: () => (
    <View className="gap-3">
      <Button label="Kod göndər" fullWidth />
      <Button label="Kod göndər" fullWidth loading />
      <Button label="Kod göndər" fullWidth disabled />
    </View>
  ),
};
