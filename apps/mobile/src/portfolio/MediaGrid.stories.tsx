import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Button, EmptyState, ImageIcon } from '../components';
import { MediaGrid } from './MediaGrid';
import { BROKEN_PHOTO_URL, LANDSCAPE_PHOTO_URL, publishedTiles } from './portfolio-fixtures';

const noop = (): void => undefined;

/**
 * A mid-range Android phone's width and a screenful of height, for the canvas
 * only: the grid is full-bleed and its tiles are a third of whatever it gets.
 */
const PHONE_FRAME = { width: 360, height: 640 } as const;

const meta = {
  title: 'Portfolio/MediaGrid',
  component: MediaGrid,
  args: { items: publishedTiles(7, LANDSCAPE_PHOTO_URL), onOpen: noop },
  decorators: [
    (Story) => (
      <View style={PHONE_FRAME}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof MediaGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Seven posts: two full rows and one tile, which stays a third wide. */
export const Playground: Story = {};

export const OneItem: Story = {
  args: { items: publishedTiles(1, LANDSCAPE_PHOTO_URL) },
};

/** Sixty posts, the profile's ceiling: the list mounts only what is on screen. */
export const ManyItems: Story = {
  args: { items: publishedTiles(60, LANDSCAPE_PHOTO_URL) },
};

/** The customer's empty state (ADR-0054 § 6). */
export const Empty: Story = {
  args: {
    items: [],
    empty: (
      <EmptyState
        title="Usta hələ iş nümunəsi paylaşmayıb."
        icon={<ImageIcon size="lg" tone="text-muted" />}
      />
    ),
  },
};

/** The master's own empty state, which carries "Yeni paylaşım" (ADR-0054 § 6). */
export const EmptyOwn: Story = {
  args: {
    items: [],
    empty: (
      <EmptyState
        title="Hələ paylaşım yoxdur"
        description="Gördüyünüz işlərin şəkillərini paylaşın. Müştərilər sizi daha yaxşı tanıyacaq."
        icon={<ImageIcon size="lg" tone="text-muted" />}
        action={<Button label="Yeni paylaşım" onPress={noop} />}
      />
    ),
  },
};

/** The master's own grid: a post processing, one that failed, and published ones (ADR-0054 § 5). */
export const OwnPostStates: Story = {
  args: {
    items: [
      { kind: 'processing', postId: 'processing' },
      { kind: 'failed', postId: 'failed' },
      ...publishedTiles(4, LANDSCAPE_PHOTO_URL),
    ],
    onPressFailed: noop,
  },
};

/** Photos that did not load: the `Image` icon in their place (ADR-0054 § 6). */
export const FailedImageLoad: Story = {
  args: { items: publishedTiles(5, BROKEN_PHOTO_URL) },
};
