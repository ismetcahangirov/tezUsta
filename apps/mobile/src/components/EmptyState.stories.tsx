import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { Button } from './Button';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  args: { title: 'Xidmət tapılmadı' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithDescription: Story = {
  args: { title: 'Xidmət tapılmadı', description: 'Bu kateqoriyada hazırda xidmət yoxdur.' },
};

export const WithAction: Story = {
  args: {
    title: 'Kataloq yüklənmədi',
    description: 'İnternet bağlantısını yoxlayın.',
    action: <Button label="Yenidən cəhd et" onPress={() => undefined} />,
  },
};
