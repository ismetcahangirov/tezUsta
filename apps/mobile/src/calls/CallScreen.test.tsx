import { fireEvent, render, screen } from '@testing-library/react-native';

import { CALL_COPY as copy } from './call-copy';
import type { CallEnd } from './call-end-reason';
import { CALL_PHASES, ENDED_CALLS, FIXTURE_CONNECTED_AT } from './call-fixtures';
import type { CallState } from './call-machine';
import { CallScreen } from './CallScreen';
import type { CallScreenProps } from './CallScreen';

function handlers() {
  return {
    onCancel: jest.fn(),
    onDecline: jest.fn(),
    onAccept: jest.fn(),
    onHangup: jest.fn(),
    onToggleMute: jest.fn(),
    onToggleSpeaker: jest.fn(),
    onClose: jest.fn(),
  };
}

async function show(
  state: CallState,
  overrides: Partial<CallScreenProps> = {},
): Promise<ReturnType<typeof handlers>> {
  const on = handlers();
  await render(
    <CallScreen
      state={state}
      peerName="Elvin Məmmədov"
      serviceName="Santexnik"
      muted={false}
      speakerOn={false}
      now={() => FIXTURE_CONNECTED_AT + 65_000}
      {...on}
      {...overrides}
    />,
  );
  return on;
}

const END_REASONS = Object.keys(ENDED_CALLS) as CallEnd[];

describe('CallScreen', () => {
  it('names the other party and the order’s service, never a number', async () => {
    await show(CALL_PHASES.incoming);

    expect(screen.getByText('Elvin Məmmədov')).toBeOnTheScreen();
    expect(screen.getByText('Santexnik')).toBeOnTheScreen();
  });

  describe('outgoing', () => {
    it('shows it is calling, and cancel reports the tap', async () => {
      const on = await show(CALL_PHASES.outgoing);

      expect(screen.getByText(copy.status.outgoing)).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: copy.controls.cancel }));
      expect(on.onCancel).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: copy.controls.accept })).toBeNull();
    });

    it('can be cancelled while the microphone question is still open', async () => {
      await show(CALL_PHASES.permissions);

      expect(screen.getByText(copy.status.permissions)).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: copy.controls.cancel })).toBeOnTheScreen();
    });
  });

  describe('incoming', () => {
    it('offers decline and accept, and each reports its own tap', async () => {
      const on = await show(CALL_PHASES.incoming);

      expect(screen.getByText(copy.status.incoming)).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: copy.controls.accept }));
      await fireEvent.press(screen.getByRole('button', { name: copy.controls.decline }));

      expect(on.onAccept).toHaveBeenCalledTimes(1);
      expect(on.onDecline).toHaveBeenCalledTimes(1);
    });

    it('cannot be accepted twice while the microphone prompt is up', async () => {
      const on = await show(CALL_PHASES.incoming, { accepting: true });

      await fireEvent.press(screen.getByRole('button', { name: copy.controls.accept }));

      expect(on.onAccept).not.toHaveBeenCalled();
    });
  });

  it('while connecting, says so and offers only a hang-up', async () => {
    const on = await show(CALL_PHASES.connecting);

    expect(screen.getByText(copy.status.connecting)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.controls.hangup }));
    expect(on.onHangup).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: copy.controls.mute })).toBeNull();
  });

  describe('in a call', () => {
    it('shows the running duration, measured from connectedAt', async () => {
      await show(CALL_PHASES.active);

      expect(screen.getByText('1:05')).toBeOnTheScreen();
      expect(screen.getByLabelText(copy.duration('1:05'))).toBeOnTheScreen();
    });

    it('offers mute, speaker and hang-up, and reports each', async () => {
      const on = await show(CALL_PHASES.active);

      await fireEvent.press(screen.getByRole('button', { name: copy.controls.mute }));
      await fireEvent.press(screen.getByRole('button', { name: copy.controls.speaker }));
      await fireEvent.press(screen.getByRole('button', { name: copy.controls.hangup }));

      expect(on.onToggleMute).toHaveBeenCalledTimes(1);
      expect(on.onToggleSpeaker).toHaveBeenCalledTimes(1);
      expect(on.onHangup).toHaveBeenCalledTimes(1);
    });

    it('announces the toggles’ state, not only their fill', async () => {
      await show(CALL_PHASES.active, { muted: true, speakerOn: false });

      expect(
        screen.getByRole('button', { name: copy.controls.mute, selected: true }),
      ).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: copy.controls.speaker, selected: false }),
      ).toBeOnTheScreen();
    });

    it('looks recovering while reconnecting: the words say so and the duration keeps running', async () => {
      await show(CALL_PHASES.reconnecting);

      expect(screen.getByText(copy.status.reconnecting)).toBeOnTheScreen();
      expect(screen.getByText('1:05')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: copy.controls.hangup })).toBeOnTheScreen();
    });

    it('says nothing about reconnecting while the call is simply held', async () => {
      await show(CALL_PHASES.active);

      expect(screen.queryByText(copy.status.reconnecting)).toBeNull();
    });
  });

  describe('ended', () => {
    it.each(END_REASONS)('says why, in its own words, for %s', async (reason) => {
      await show(ENDED_CALLS[reason]);

      expect(screen.getByText(copy.ended[reason])).toBeOnTheScreen();
    });

    it('has nine distinct sentences, none of which says "error"', () => {
      const sentences = END_REASONS.map((reason) => copy.ended[reason]);

      expect(END_REASONS).toHaveLength(9);
      expect(new Set(sentences).size).toBe(9);
      for (const sentence of sentences) {
        expect(sentence).not.toMatch(/error|xəta|səhv/i);
      }
    });

    it('stays until closed, with one close button and no call controls', async () => {
      const on = await show(ENDED_CALLS.dropped);

      expect(screen.getAllByRole('button')).toHaveLength(1);
      await fireEvent.press(screen.getByRole('button', { name: copy.controls.close }));
      expect(on.onClose).toHaveBeenCalledTimes(1);
    });
  });
});
