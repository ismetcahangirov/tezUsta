import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Divider } from './Divider';
import { ChevronRightIcon } from './icons';
import { IconButton } from './IconButton';
import { ListRow } from './ListRow';

const SERVICES = ['Santexnika', 'Elektrik', 'Kondisioner', 'Qapı və kilid'];

const meta = {
  title: 'Components/ListRow',
  component: ListRow,
  args: { title: 'Kran sızır', subtitle: 'Nizami rayonu' },
} satisfies Meta<typeof ListRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const ServiceList: Story = {
  render: () => (
    <View>
      {SERVICES.map((title, index) => (
        <View key={title}>
          <ListRow
            title={title}
            trailing={
              <IconButton
                accessibilityLabel={title}
                icon={<ChevronRightIcon tone="on-inverse" />}
              />
            }
            onPress={() => undefined}
          />
          {index < SERVICES.length - 1 && <Divider />}
        </View>
      ))}
    </View>
  ),
};

export const WithProgress: Story = {
  args: { title: 'Sənədlərin yoxlanması', progress: { value: 2, max: 3 } },
};
