import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { IconButton, PhoneIcon } from '../components';
import { CALL_COPY as copy } from './call-copy';

/**
 * The call entry point's control, drawn directly: `CallEntry` itself renders
 * nothing while `CALLING_ENABLED` is off (ADR-0039 § 3), so a story of it would
 * be an empty canvas. This is exactly the element it renders when it is on —
 * the default `IconButton` with the phone glyph — on the two surfaces it sits
 * on: the order's status card and a screen header.
 */
const meta = {
  title: 'Calls/CallEntry',
  component: IconButton,
  args: {
    accessibilityLabel: copy.entry.customer,
    icon: <PhoneIcon tone="on-inverse" />,
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnTheStatusCard: Story = {
  decorators: [
    (Story) => (
      <View className="flex-row items-center justify-between rounded-md bg-surface p-4">
        <Story />
      </View>
    ),
  ],
};

export const InAHeader: Story = {
  args: { accessibilityLabel: copy.entry.master },
  decorators: [
    (Story) => (
      <View className="flex-row items-center justify-end bg-bg p-4">
        <Story />
      </View>
    ),
  ],
};
