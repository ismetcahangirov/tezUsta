import { act, renderHook } from '@testing-library/react-native';

import { useBoundedRefresh } from './useBoundedRefresh';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useBoundedRefresh', () => {
  it('re-reads on the interval while enabled, and stops after the bound', async () => {
    const refetch = jest.fn();
    await renderHook(() => {
      useBoundedRefresh({ enabled: true, refetch, intervalMs: 1_000, maxAttempts: 3 });
    });

    await act(() => {
      jest.advanceTimersByTime(10_000);
    });

    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it('asks nothing while disabled, and stops the moment it is disabled', async () => {
    const refetch = jest.fn();
    const { rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) => {
        useBoundedRefresh({ enabled, refetch, intervalMs: 1_000, maxAttempts: 10 });
      },
      { initialProps: { enabled: false } },
    );

    await act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(refetch).not.toHaveBeenCalled();

    await rerender({ enabled: true });
    await act(() => {
      jest.advanceTimersByTime(2_500);
    });
    expect(refetch).toHaveBeenCalledTimes(2);

    await rerender({ enabled: false });
    await act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh count for a later wait', async () => {
    const refetch = jest.fn();
    const { rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) => {
        useBoundedRefresh({ enabled, refetch, intervalMs: 1_000, maxAttempts: 2 });
      },
      { initialProps: { enabled: true } },
    );
    await act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(refetch).toHaveBeenCalledTimes(2);

    await rerender({ enabled: false });
    await rerender({ enabled: true });
    await act(() => {
      jest.advanceTimersByTime(10_000);
    });

    expect(refetch).toHaveBeenCalledTimes(4);
  });
});
