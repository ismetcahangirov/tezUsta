import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Button } from './Button';
import { Divider } from './Divider';
import { ListRow } from './ListRow';
import { Sheet } from './Sheet';
import { Text } from './Text';

const meta = {
  title: 'Components/Sheet',
  component: Sheet,
  args: { title: 'Sifariş' },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OverMap: Story = {
  render: () => (
    <Sheet title="Kran sızır">
      <View>
        <ListRow title="Kateqoriya" trailing={<Text>Santexnika</Text>} />
        <Divider />
        <ListRow title="Ünvan" trailing={<Text>Nizami r.</Text>} />
        <Divider />
        <ListRow title="Qiymət" trailing={<Text variant="body-strong">25 AZN</Text>} />
      </View>
      <Button label="Ustanı çağır" variant="accent" size="lg" fullWidth />
    </Sheet>
  ),
};
