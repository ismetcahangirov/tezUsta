import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Banner } from '../components';
import { LANDSCAPE_PHOTO_URL, PORTRAIT_PHOTO_URL } from '../portfolio/portfolio-fixtures';
import { Composer } from './Composer';
import { CONVERSATION_COPY as copy } from './conversation-copy';
import type { MessagePhotos } from './useMessagePhotos';

/** A strip with one photo of each state; the controls do nothing here. */
const DRAFTED: MessagePhotos = {
  photos: [
    { localId: 'ready', uri: LANDSCAPE_PHOTO_URL, status: 'ready' },
    { localId: 'uploading', uri: PORTRAIT_PHOTO_URL, status: 'uploading' },
    { localId: 'failed', uri: LANDSCAPE_PHOTO_URL, status: 'failed' },
  ],
  isPicking: false,
  permissionDenied: false,
  canAdd: true,
  ready: false,
  pick: () => Promise.resolve(),
  remove: () => undefined,
  take: () => [],
};

const meta = {
  title: 'Conversation/Composer',
  component: Composer,
  args: { onSend: () => undefined },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type into it: send stays disabled until there is something to send. */
export const Playground: Story = {};

/**
 * Photos waiting for the next message (ADR-0067 § 1–2): the photo control on
 * the left, and the strip above the field with each photo's state in words.
 * Send stays disabled until every photo has uploaded.
 */
export const WithPhotos: Story = {
  args: { photos: DRAFTED },
};

/**
 * What stands where the composer was once the order is over. The composer is
 * absent rather than disabled (ADR-0033 § 2); this is the line that says why.
 */
export const ClosedConversation: Story = {
  render: () => <Banner message={copy.closedNotice} />,
};
