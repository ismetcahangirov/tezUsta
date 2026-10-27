import { act, renderHook } from '@testing-library/react-native';

import { useHandBackOpen } from './useHandBackOpen';

/** Moves the timers, and with them `Date.now()`, as real time would. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

describe('useHandBackOpen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is open before the deadline and closes by itself when it passes', async () => {
    const until = new Date(Date.now() + 30_000).toISOString();
    const { result } = await renderHook(() => useHandBackOpen(until));

    expect(result.current).toBe(true);

    await elapse(29_000);
    expect(result.current).toBe(true);

    await elapse(1_000);
    expect(result.current).toBe(false);
  });

  it('is closed for a deadline already past', async () => {
    const until = new Date(Date.now() - 1).toISOString();
    const { result } = await renderHook(() => useHandBackOpen(until));

    expect(result.current).toBe(false);
  });

  it('is closed while there is no job to read a deadline from', async () => {
    const { result } = await renderHook(() => useHandBackOpen(undefined));

    expect(result.current).toBe(false);
  });
});
