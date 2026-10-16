import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ImageIcon } from './icons';

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

/** ADR-0054 § 6: the portfolio's empty state, an icon until the owner supplies art. */
export const WithIcon: Story = {
  args: {
    title: 'Hələ paylaşım yoxdur',
    description: 'Gördüyünüz işlərin şəkillərini paylaşın. Müştərilər sizi daha yaxşı tanıyacaq.',
    icon: <ImageIcon size="lg" tone="text-muted" />,
    action: <Button label="Yeni paylaşım" onPress={() => undefined} />,
  },
};
