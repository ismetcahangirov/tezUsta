import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { useState } from 'react';
import { View } from 'react-native';

import type { CallEnd } from './call-end-reason';
import { CALL_PHASES, ENDED_CALLS, FIXTURE_CONNECTED_AT } from './call-fixtures';
import { CallScreen } from './CallScreen';

/** A clock pinned 65 seconds into the call, so the duration reads `1:05` in every capture. */
const pinnedNow = (): number => FIXTURE_CONNECTED_AT + 65_000;

const noop = (): void => undefined;

/**
 * A mid-range Android phone's viewport, for the story canvas only. Not a
 * design value — the screen itself is full-bleed and sizes nothing — but the
 * layout pins its controls to the bottom, which only reads at a phone's
 * proportions.
 */
const PHONE_FRAME = { width: 360, height: 640 } as const;

const meta = {
  title: 'Calls/CallScreen',
  component: CallScreen,
  args: {
    state: CALL_PHASES.incoming,
    peerName: 'Elvin Məmmədov',
    serviceName: 'Santexnik',
    muted: false,
    speakerOn: false,
    now: pinnedNow,
    onCancel: noop,
    onDecline: noop,
    onAccept: noop,
    onHangup: noop,
    onToggleMute: noop,
    onToggleSpeaker: noop,
    onClose: noop,
  },
  decorators: [
    (Story) => (
      <View style={PHONE_FRAME}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof CallScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Outgoing: Story = { args: { state: CALL_PHASES.outgoing } };

export const AskingForTheMicrophone: Story = { args: { state: CALL_PHASES.permissions } };

export const Incoming: Story = { args: { state: CALL_PHASES.incoming } };

export const Connecting: Story = { args: { state: CALL_PHASES.connecting } };

export const Active: Story = { args: { state: CALL_PHASES.active } };

/** Muted and on speaker: the toggles' "on" fill. */
export const ActiveMutedOnSpeaker: Story = {
  args: { state: CALL_PHASES.active, muted: true, speakerOn: true },
};

/** The duration keeps its place, loses its lime, and the words say what is happening. */
export const Reconnecting: Story = { args: { state: CALL_PHASES.reconnecting } };

/** A service name not yet read: the line is left out, not shown blank. */
export const WithoutService: Story = { args: { state: CALL_PHASES.active, serviceName: null } };

/** The toggles as a person uses them — local state only, the room bridge is not here. */
export const TogglesInteractive: Story = {
  render: (args) => {
    const [muted, setMuted] = useState(false);
    const [speakerOn, setSpeakerOn] = useState(false);
    return (
      <CallScreen
        {...args}
        state={CALL_PHASES.active}
        muted={muted}
        speakerOn={speakerOn}
        onToggleMute={() => {
          setMuted((value) => !value);
        }}
        onToggleSpeaker={() => {
          setSpeakerOn((value) => !value);
        }}
      />
    );
  },
};

function ended(reason: CallEnd): Story {
  return { args: { state: ENDED_CALLS[reason] } };
}

export const EndedCompleted = ended('completed');
export const EndedDeclined = ended('declined');
export const EndedNoAnswer = ended('no_answer');
export const EndedBusy = ended('busy');
export const EndedCancelled = ended('cancelled');
export const EndedPermissionDenied = ended('permission_denied');
export const EndedConnectFailed = ended('connect_failed');
export const EndedDropped = ended('dropped');
export const EndedError = ended('error');
