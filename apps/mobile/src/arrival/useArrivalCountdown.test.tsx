import type { ArrivalPromise } from '@tezusta/types';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { formatMessageTime } from '../conversation/format-message-time';
import { COUNTDOWN_TICK_MS, useArrivalCountdown } from './useArrivalCountdown';

/** The phone's monotonic clock, driven by the test rather than by the runner. */
let mockMono = 0;
jest.mock('../lib/monotonic-clock', () => ({ monotonicNow: () => mockMono }));

function promise(
  secondsRemaining: number,
  promisedAt = '2026-10-20T10:12:30.000Z',
): ArrivalPromise {
  return { promisedAt, secondsRemaining, source: 'route' };
}

/** Moves both the monotonic clock and the timers, as real time would. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    mockMono += ms;
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

/** Built once: in the app the promise is a stable object from the cache, re-made only by a new read or frame. */
const fixed2 = promise(2);
const fixed125 = promise(125);
const fixed300 = promise(300);
const fixed600 = promise(600);

/** The countdown's own 1 Hz intervals still running, ignoring the test library's timers. */
let live = new Set<unknown>();
function tickIntervals(): number {
  return live.size;
}

describe('useArrivalCountdown (ADR-0055 § 13)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMono = 1_000_000;
    live = new Set();
    const setInterval = global.setInterval;
    const clearInterval = global.clearInterval;
    jest.spyOn(global, 'setInterval').mockImplementation((handler: () => void, ms?: number) => {
      const id = setInterval(handler, ms);
      if (ms === COUNTDOWN_TICK_MS) {
        live.add(id);
      }
      return id;
    });
    jest.spyOn(global, 'clearInterval').mockImplementation((id?: unknown) => {
      live.delete(id);
      clearInterval(id as Parameters<typeof clearInterval>[0]);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is pending until a promise exists', async () => {
    const { result } = await renderHook(() => useArrivalCountdown(null));

    expect(result.current).toStrictEqual({ state: 'pending', clockTime: null });
    expect(tickIntervals()).toBe(0);
  });

  it('counts down once a second and prints the promised time of day', async () => {
    const { result } = await renderHook(() => useArrivalCountdown(fixed125));

    expect(result.current).toMatchObject({ state: 'counting', minutesLeft: 3, secondsLeft: 125 });
    expect(result.current.clockTime).toBe(formatMessageTime('2026-10-20T10:12:30.000Z'));

    await elapse(COUNTDOWN_TICK_MS * 10);
    expect(result.current).toMatchObject({ minutesLeft: 2, secondsLeft: 115 });
  });

  it('crosses zero into late', async () => {
    const { result } = await renderHook(() => useArrivalCountdown(fixed2));

    await elapse(COUNTDOWN_TICK_MS * 3);

    expect(result.current).toMatchObject({ state: 'late', lateByMinutes: 1 });
  });

  it('ignores the phone’s wall clock, however wrong it is', async () => {
    const { result } = await renderHook(() => useArrivalCountdown(fixed300));

    await act(async () => {
      jest.setSystemTime(Date.now() + 5 * 60_000);
      await Promise.resolve();
    });
    await elapse(COUNTDOWN_TICK_MS);
    expect(result.current).toMatchObject({ state: 'counting', secondsLeft: 299 });

    await act(async () => {
      jest.setSystemTime(Date.now() - 10 * 60_000);
      await Promise.resolve();
    });
    await elapse(COUNTDOWN_TICK_MS);
    expect(result.current).toMatchObject({ state: 'counting', secondsLeft: 298 });
  });

  it('re-anchors on a newer read or frame', async () => {
    const { result, rerender } = await renderHook(
      ({ current }: { current: ArrivalPromise }) => useArrivalCountdown(current),
      { initialProps: { current: promise(600) } },
    );
    await elapse(COUNTDOWN_TICK_MS * 30);
    expect(result.current).toMatchObject({ secondsLeft: 570 });

    // The server measured 540 s left when it answered: the read wins.
    await rerender({ current: promise(540) });

    expect(result.current).toMatchObject({ secondsLeft: 540 });
  });

  it('does not tick while the screen is unfocused, and is right again when it returns', async () => {
    const { result, rerender } = await renderHook(
      ({ active }: { active: boolean }) => useArrivalCountdown(fixed600, active),
      { initialProps: { active: false } },
    );
    expect(tickIntervals()).toBe(0);

    await elapse(COUNTDOWN_TICK_MS * 60);
    await rerender({ active: true });

    expect(result.current).toMatchObject({ secondsLeft: 540 });
  });

  it('does not tick in the background', async () => {
    let onChange: ((state: AppStateStatus) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      onChange = listener;
      return { remove: jest.fn() };
    });
    await renderHook(() => useArrivalCountdown(fixed600));
    expect(tickIntervals()).toBe(1);

    await act(async () => {
      onChange?.('background');
      await Promise.resolve();
    });

    expect(tickIntervals()).toBe(0);
  });

  it('leaves no timer behind once it unmounts', async () => {
    const { unmount } = await renderHook(() => useArrivalCountdown(fixed600));
    expect(tickIntervals()).toBe(1);

    await unmount();

    expect(tickIntervals()).toBe(0);
  });
});
