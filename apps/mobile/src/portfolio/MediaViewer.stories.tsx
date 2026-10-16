import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { MediaViewer } from './MediaViewer';
import {
  BROKEN_PHOTO_POST,
  LONG_CAPTION_POST,
  MANY_PHOTOS_POST,
  NO_CAPTION_POST,
  ONE_PHOTO_POST,
  withLoadingPhotos,
} from './portfolio-fixtures';

const noop = (): void => undefined;

/**
 * A mid-range Android phone's viewport, for the canvas only. The viewer is
 * full-bleed; its photo, dots and caption only read at a phone's proportions.
 * It looks the same with the toolbar on Light or Dark: that is the point
 * (ADR-0054 § 3).
 */
const PHONE_FRAME = { width: 360, height: 640 } as const;

const meta = {
  title: 'Portfolio/MediaViewer',
  component: MediaViewer,
  args: { post: withLoadingPhotos(MANY_PHOTOS_POST), onClose: noop },
  decorators: [
    (Story) => (
      <View style={PHONE_FRAME}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof MediaViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Five photos: the counter and the dots. Swipe to page. */
export const ManyItems: Story = {};

/** One photo: no counter, no dots. */
export const OneItem: Story = {
  args: { post: withLoadingPhotos(ONE_PHOTO_POST) },
};

/** Opened on the third photo, as from a tile. */
export const OpenedOnThird: Story = {
  args: { initialIndex: 2 },
};

/** A caption longer than a third of the screen scrolls in its own area. */
export const LongCaption: Story = {
  args: { post: withLoadingPhotos(LONG_CAPTION_POST) },
};

/** No caption and no service: nothing under the photo. */
export const NoCaption: Story = {
  args: { post: withLoadingPhotos(NO_CAPTION_POST) },
};

/** The master's own post: edit and delete on the right of the top bar. */
export const OwnPost: Story = {
  args: { ownerActions: { onEdit: noop, onDelete: noop } },
};

/** A photo that did not load: the `Image` icon in `on-inverse`. */
export const FailedImageLoad: Story = {
  args: { post: BROKEN_PHOTO_POST },
};
