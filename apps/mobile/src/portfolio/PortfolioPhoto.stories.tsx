import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { FixedScheme } from '../theme';
import { BROKEN_PHOTO_URL, LANDSCAPE_PHOTO_URL, PORTRAIT_PHOTO_URL } from './portfolio-fixtures';
import { PortfolioPhoto } from './PortfolioPhoto';
import { PHOTO_SURFACE_SCHEME } from './viewer-surface';

const meta = {
  title: 'Portfolio/PortfolioPhoto',
  component: PortfolioPhoto,
  args: {
    uri: LANDSCAPE_PHOTO_URL,
    contentFit: 'cover',
    fallbackTone: 'text-muted',
    className: 'h-avatar-lg w-avatar-lg rounded-sm bg-surface-alt',
  },
} satisfies Meta<typeof PortfolioPhoto>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A grid tile: cropped to the square. */
export const Tile: Story = {};

/** The viewer: the whole photo, on black. */
export const Whole: Story = {
  args: { uri: PORTRAIT_PHOTO_URL, contentFit: 'contain', fallbackTone: 'on-inverse' },
  render: (args) => (
    <FixedScheme scheme={PHOTO_SURFACE_SCHEME} className="bg-inverse-surface">
      <PortfolioPhoto {...args} className="aspect-square w-full" />
    </FixedScheme>
  ),
};

/** Did not load, on the page and on the viewer. */
export const FailedImageLoad: Story = {
  args: { uri: BROKEN_PHOTO_URL },
  render: (args) => (
    <View className="flex-row gap-4">
      <PortfolioPhoto {...args} />
      <FixedScheme scheme={PHOTO_SURFACE_SCHEME} className="bg-inverse-surface">
        <PortfolioPhoto {...args} contentFit="contain" fallbackTone="on-inverse" />
      </FixedScheme>
    </View>
  ),
};
