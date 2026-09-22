import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, Linking } from 'react-native';

import { useOsNotificationPermission } from './useOsNotificationPermission';

const mockGetPermission = jest.fn(() => Promise.resolve('granted' as const));

jest.mock('./push-adapter', () => ({
  get expoPushPlatform() {
    return { getPermission: mockGetPermission };
  },
}));

/**
 * Every `AppState.addEventListener` in this file goes through one spy.
 *
 * The environment's own implementation does not return a subscription object,
 * so the hook's cleanup — which calls `remove()` on it, as React Native
 * documents — throws at unmount. Substituting it in one place keeps that
 * contract honest in the test instead of weakening it in the hook.
 */
const appStateListeners: ((state: string) => void)[] = [];
let appStateSpy: jest.SpyInstance;

function goActive(state: string): void {
  for (const listener of appStateListeners) {
    listener(state);
  }
}

describe('useOsNotificationPermission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPermission.mockResolvedValue('granted');
    appStateListeners.length = 0;
    appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event: string, handler: (state: never) => void) => {
        appStateListeners.push(handler as (state: string) => void);
        return { remove: () => undefined };
      });
  });

  afterEach(() => {
    appStateSpy.mockRestore();
  });

  it('reports nothing until the platform has answered', async () => {
    // `undefined` is not `blocked`. Rendering a warning during the first frame
    // of every launch would be a warning nobody trusts.
    let resolve: ((value: 'granted') => void) | undefined;
    mockGetPermission.mockReturnValue(
      new Promise<'granted'>((r) => {
        resolve = r;
      }),
    );

    const { result } = await renderHook(() => useOsNotificationPermission());

    expect(result.current.permission).toBeUndefined();

    await act(() => {
      resolve?.('granted');
    });

    await waitFor(() => {
      expect(result.current.permission).toBe('granted');
    });
  });

  it('reports what the platform said', async () => {
    mockGetPermission.mockResolvedValue('blocked' as never);

    const { result } = await renderHook(() => useOsNotificationPermission());

    await waitFor(() => {
      expect(result.current.permission).toBe('blocked');
    });
  });

  it('re-reads when the app returns to the foreground', async () => {
    // Changing a notification setting means leaving for the system settings
    // app and coming back. A screen that still said "blocked" afterwards would
    // be telling the user their own change did not work.
    mockGetPermission.mockResolvedValue('blocked' as never);
    const { result } = await renderHook(() => useOsNotificationPermission());

    await waitFor(() => {
      expect(result.current.permission).toBe('blocked');
    });

    mockGetPermission.mockResolvedValue('granted');
    await act(() => {
      goActive('active');
    });

    await waitFor(() => {
      expect(result.current.permission).toBe('granted');
    });
  });

  it('does not re-read when the app merely goes to the background', async () => {
    await renderHook(() => useOsNotificationPermission());

    await waitFor(() => {
      expect(mockGetPermission).toHaveBeenCalledTimes(1);
    });

    await act(() => {
      goActive('background');
    });

    expect(mockGetPermission).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the platform cannot answer at all', async () => {
    // A platform that throws is not a platform that is blocking, and a warning
    // with no evidence behind it is worse than no warning.
    mockGetPermission.mockRejectedValue(new Error('no native module'));

    const { result } = await renderHook(() => useOsNotificationPermission());

    await waitFor(() => {
      expect(mockGetPermission).toHaveBeenCalled();
    });
    expect(result.current.permission).toBeUndefined();
  });

  it('opens the system settings without making the caller wait', async () => {
    const spy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);

    const { result } = await renderHook(() => useOsNotificationPermission());

    expect(result.current.openSystemSettings()).toBeUndefined();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('survives a platform with no settings screen', async () => {
    const spy = jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('unsupported'));

    const { result } = await renderHook(() => useOsNotificationPermission());

    // The assertion is the absence of an unhandled rejection: one would fail
    // the suite, and nothing renders differently for having failed to open.
    result.current.openSystemSettings();
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    spy.mockRestore();
  });
});
