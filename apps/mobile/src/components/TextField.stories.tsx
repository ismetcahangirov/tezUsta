import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { TextField } from './TextField';

const meta = {
  title: 'Components/TextField',
  component: TextField,
  args: { label: 'Telefon nömrəsi', placeholder: '+994 __ ___ __ __' },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const States: Story = {
  render: () => (
    <View className="gap-6">
      <TextField label="Telefon nömrəsi" placeholder="+994 __ ___ __ __" />
      <TextField label="Telefon nömrəsi" value="+994 50 123 45 67" />
      <TextField label="Telefon nömrəsi" value="+994 50" error="Nömrə tam deyil" />
      <TextField label="Telefon nömrəsi" value="+994 50 123 45 67" editable={false} />
    </View>
  ),
};
