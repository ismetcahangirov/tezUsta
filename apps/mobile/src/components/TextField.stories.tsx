import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { TextField } from './TextField';

const meta = {
  title: 'Components/TextField',
  component: TextField,
  args: { label: 'E-poçt ünvanı', placeholder: 'ad@example.com' },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const States: Story = {
  render: () => (
    <View className="gap-6">
      <TextField label="E-poçt ünvanı" placeholder="ad@example.com" />
      <TextField label="E-poçt ünvanı" value="aysel@example.az" />
      <TextField label="E-poçt ünvanı" value="aysel@example" error="E-poçt ünvanı düzgün deyil." />
      <TextField label="E-poçt ünvanı" value="aysel@example.az" editable={false} />
    </View>
  ),
};

/** The review comment (issue #227): grows from `control-lg`, rounded to `lg`. */
export const Multiline: Story = {
  render: () => (
    <View className="gap-6">
      <TextField label="Şərh" multiline placeholder="Nə yaxşı idi, nə yaxşı ola bilərdi?" />
      <TextField
        label="Şərh"
        multiline
        value={'Vaxtında gəldi, kranı dəyişdi.\nİşdən sonra hər yeri təmizlədi.'}
      />
    </View>
  ),
};
