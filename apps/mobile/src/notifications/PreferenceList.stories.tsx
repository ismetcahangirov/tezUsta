import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import type { NotificationPreference } from '@tezusta/types';

import { PreferenceList } from './PreferenceList';

/**
 * The arrangement and every string here are placeholders (CLAUDE.md §17). The
 * point of the story is the shape: what a locked category looks like beside a
 * changeable one, which is the decision the owner is being asked to confirm.
 */
const LOCKED_ON: NotificationPreference = {
  category: 'order-offers',
  enabled: true,
  changeable: false,
};

const CHANGEABLE_ON: NotificationPreference = {
  category: 'order-progress',
  enabled: true,
  changeable: true,
};

const CHANGEABLE_OFF: NotificationPreference = { ...CHANGEABLE_ON, enabled: false };

const meta = {
  title: 'Notifications/PreferenceList',
  component: PreferenceList,
  args: {
    onChoose: () => undefined,
  },
} satisfies Meta<typeof PreferenceList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What a customer actually sees today: four locked categories and one switch. */
export const Playground: Story = {
  args: {
    preferences: [
      LOCKED_ON,
      { category: 'order-accepted', enabled: true, changeable: false },
      CHANGEABLE_ON,
      { category: 'order-cancelled', enabled: true, changeable: false },
      { category: 'order-no-master-found', enabled: true, changeable: false },
    ],
  },
};

export const SwitchedOff: Story = {
  args: { preferences: [CHANGEABLE_OFF] },
};

/** A write is in flight; the control still shows its position and ignores taps. */
export const Busy: Story = {
  args: { preferences: [CHANGEABLE_ON], busy: true },
};

/**
 * A category the server has and the app has not been taught.
 *
 * It renders under its own key rather than disappearing — a toggle that
 * vanished would read as a missing feature.
 */
export const UnnamedCategory: Story = {
  args: {
    preferences: [
      {
        category: 'order-digest' as NotificationPreference['category'],
        enabled: true,
        changeable: true,
      },
    ],
  },
};
