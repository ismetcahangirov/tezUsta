import { act, renderHook } from '@testing-library/react-native';

import type { CallEvent, CallState, PeerPresence } from './call-machine';
import { graceIsRunning, REMOTE_GRACE_MS, useRemoteGrace } from './useRemoteGrace';

function held(phase: 'active' | 'reconnecting', peer: PeerPresence): CallState {
  return { phase, orderId: 'order-1', callId: 'call-1', connectedAt: 1_000, peer };
}

async function mount(initial: CallState) {
  const dispatched: CallEvent[] = [];
  const dispatch = (event: CallEvent) => {
    dispatched.push(event);
  };
  const hook = await renderHook(
    ({ state }: { state: CallState }) => {
      useRemoteGrace(state, dispatch);
    },
    { initialProps: { state: initial } },
  );
  return { dispatched, rerender: (state: CallState) => hook.rerender({ state }) };
}

async function elapse(ms: number): Promise<void> {
  await act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * The grace before a vanished peer ends the call (issue #187, ADR-0034 § 4).
 * A peer whose app was killed can flap once during its own reconnect window;
 * ending on the first departure kills calls that would have come back.
 */
describe('the remote grace', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs only while the call is active and the peer was there and left', () => {
    expect(graceIsRunning(held('active', 'away'))).toBe(true);
    expect(graceIsRunning(held('active', 'present'))).toBe(false);
    expect(graceIsRunning(held('active', 'awaiting'))).toBe(false);
    expect(graceIsRunning(held('reconnecting', 'away'))).toBe(false);
  });

  it('ends the call once the peer has been gone for the whole grace', async () => {
    const hook = await mount(held('active', 'away'));

    await elapse(REMOTE_GRACE_MS - 1);
    expect(hook.dispatched).toEqual([]);

    await elapse(1);
    expect(hook.dispatched).toEqual([{ type: 'remote-gone-after-grace' }]);
  });

  it('does nothing when the peer rejoins within the grace', async () => {
    const hook = await mount(held('active', 'away'));

    await elapse(REMOTE_GRACE_MS / 2);
    await hook.rerender(held('active', 'present'));
    await elapse(REMOTE_GRACE_MS * 2);

    expect(hook.dispatched).toEqual([]);
  });

  it('gives a peer who leaves again a full grace, not what was left of the last one', async () => {
    const hook = await mount(held('active', 'away'));

    await elapse(REMOTE_GRACE_MS - 10);
    await hook.rerender(held('active', 'present'));
    await hook.rerender(held('active', 'away'));
    await elapse(REMOTE_GRACE_MS - 10);

    expect(hook.dispatched).toEqual([]);
  });

  it('pauses while this phone reconnects, and re-arms in full once it is back', async () => {
    const hook = await mount(held('active', 'away'));

    await elapse(REMOTE_GRACE_MS - 10);
    await hook.rerender(held('reconnecting', 'away'));
    await elapse(REMOTE_GRACE_MS * 2);
    expect(hook.dispatched).toEqual([]);

    await hook.rerender(held('active', 'away'));
    await elapse(REMOTE_GRACE_MS);
    expect(hook.dispatched).toEqual([{ type: 'remote-gone-after-grace' }]);
  });
});
