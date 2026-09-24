import { act, renderHook } from '@testing-library/react-native';

import { CALL_DURATION_TICK_MS, useCallDuration } from './useCallDuration';

let clock = 0;
const now = (): number => clock;

async function elapse(ms: number): Promise<void> {
  await act(() => {
    clock += ms;
    jest.advanceTimersByTime(ms);
  });
}

describe('useCallDuration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clock = 100_000;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is null for a call that never got into the room', async () => {
    const hook = await renderHook(() => useCallDuration(null, now));

    await elapse(5_000);

    expect(hook.result.current).toBeNull();
  });

  it('is measured from connectedAt, so a screen opened late shows the time already spent', async () => {
    const hook = await renderHook(() => useCallDuration(clock - 42_000, now));

    expect(hook.result.current).toBe(42_000);
  });

  it('keeps running once a second while the call is held', async () => {
    const connectedAt = clock;
    const hook = await renderHook(() => useCallDuration(connectedAt, now));

    await elapse(CALL_DURATION_TICK_MS);
    expect(hook.result.current).toBe(1_000);

    await elapse(CALL_DURATION_TICK_MS * 64);
    expect(hook.result.current).toBe(65_000);
  });

  it('re-reads the clock rather than counting ticks, so a late tick does not drift', async () => {
    const connectedAt = clock;
    const hook = await renderHook(() => useCallDuration(connectedAt, now));

    // The JS thread was busy: the clock moved ten seconds, the timer fired once.
    await act(() => {
      clock += 10_000;
      jest.advanceTimersByTime(CALL_DURATION_TICK_MS);
    });

    expect(hook.result.current).toBe(10_000);
  });
});
