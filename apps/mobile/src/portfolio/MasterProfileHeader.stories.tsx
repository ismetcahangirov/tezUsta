import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { MasterProfileHeader } from './MasterProfileHeader';
import { LANDSCAPE_PHOTO_URL, LONG_BIO, PROFILE } from './portfolio-fixtures';

const meta = {
  title: 'Portfolio/MasterProfileHeader',
  component: MasterProfileHeader,
  args: { profile: PROFILE },
} satisfies Meta<typeof MasterProfileHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No avatar: the initials. */
export const Playground: Story = {};

export const WithAvatar: Story = {
  args: { profile: { ...PROFILE, avatarLargeUrl: LANDSCAPE_PHOTO_URL } },
};

/**
 * A bio past four lines is clamped. On the device it ends with "Daha çox";
 * React Native Web does not report text lines, so here it only clamps.
 */
export const LongBio: Story = {
  args: { profile: { ...PROFILE, bio: LONG_BIO } },
};

/** A long name: two lines, then truncated. */
export const LongName: Story = {
  args: {
    profile: { ...PROFILE, displayName: 'Məmmədəli Əliheydər oğlu Qasımzadə-Hüseynov' },
  },
};

/** Nobody has rated them, and they wrote no bio and offer no service yet. */
export const Bare: Story = {
  args: {
    profile: {
      ...PROFILE,
      bio: null,
      services: [],
      rating: { ratingAverage: null, ratingCount: 0 },
    },
  },
};
