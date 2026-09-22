import { renderHook, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { PushPermission } from './push-permission';
import { signedIn } from '../store/session-slice';
import { usePushAccessPrompt, usePushRegistration } from './usePushRegistration';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockRotation: { fire: (() => void) | null; removed: boolean } = {
  fire: null,
  removed: false,
};

const mockPush = {
  isSupported: true,
  ensureChannels: jest.fn(() => Promise.resolve()),
  getPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('granted')),
  requestPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('granted')),
  acquireToken: jest.fn(() => Promise.resolve('ExponentPushToken[aaa]')),
  describeDevice: () => ({
    platform: 'android' as const,
    deviceId: 'Pixel 7',
    appVersion: '0.1.0',
  }),
};

/**
 * The adapter, substituted — this file is about what the app does with the
 * platform's answers, not about the platform.
 *
 * `expoPushPlatform` is read through a getter because `jest.mock` factories are
 * hoisted above every `const` in the file: returning `mockPush` directly would
 * capture it while it is still undefined, and the hook would quietly see a
 * platform that supports nothing.
 */
jest.mock('./push-adapter', () => ({
  get expoPushPlatform() {
    return mockPush;
  },
  addPushTokenRotationListener: (onRotation: () => void) => {
    mockRotation.fire = onRotation;
    return {
      remove: () => {
        mockRotation.removed = true;
      },
    };
  },
}));

/** Every body posted to `POST /devices`, in order. */
const registrations: unknown[] = [];

function installTransport(status = 201): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    registrations.push(JSON.parse(await request.clone().text()));

    if (status >= 400) {
      return new Response(JSON.stringify({ code: 'INTERNAL' }), { status });
    }

    return new Response(
      JSON.stringify({
        id: 'device-1',
        platform: 'android',
        tokenSuffix: 'aaa',
        deviceId: 'Pixel 7',
        appVersion: '0.1.0',
        createdAt: '2026-09-22T09:00:00.000Z',
        updatedAt: '2026-09-22T09:00:00.000Z',
        lastSeenAt: '2026-09-22T09:00:00.000Z',
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

function wrapperFor(signedInUser: boolean): React.ComponentType<{ children: React.ReactNode }> {
  const store = createTestStore();
  if (signedInUser) {
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
  }

  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <Provider store={store}>{children}</Provider>;
  };
}

function renderPush(
  signedInUser = true,
): Promise<{ result: { current: () => void }; unmount: () => Promise<void> }> {
  return renderHook(
    () => {
      usePushRegistration();
      return usePushAccessPrompt();
    },
    { wrapper: wrapperFor(signedInUser) },
  );
}

describe('usePushRegistration', () => {
  beforeEach(() => {
    // Call counts are assertions in this file, and the mocks are module-level.
    jest.clearAllMocks();
    registrations.length = 0;
    mockRotation.fire = null;
    mockRotation.removed = false;
    mockPush.getPermission.mockResolvedValue('granted');
    mockPush.requestPermission.mockResolvedValue('granted');
    installTransport();
  });

  it('registers a signed-in phone that has already granted permission', async () => {
    await renderPush();

    await waitFor(() => {
      expect(registrations).toEqual([
        {
          expoPushToken: 'ExponentPushToken[aaa]',
          platform: 'android',
          deviceId: 'Pixel 7',
          appVersion: '0.1.0',
        },
      ]);
    });
  });

  it('registers nobody while the session is still being restored', async () => {
    await renderPush(false);

    expect(registrations).toEqual([]);
    expect(mockPush.getPermission).not.toHaveBeenCalled();
  });

  it('shows no permission dialog at launch, however undecided the phone is', async () => {
    mockPush.getPermission.mockResolvedValue('askable');

    await renderPush();

    await waitFor(() => {
      expect(mockPush.getPermission).toHaveBeenCalled();
    });
    expect(mockPush.requestPermission).not.toHaveBeenCalled();
    expect(registrations).toEqual([]);
  });

  it('asks only from the prompt call site, and registers once the user agrees', async () => {
    mockPush.getPermission.mockResolvedValue('askable');

    const { result } = await renderPush();
    result.current();

    await waitFor(() => {
      expect(mockPush.requestPermission).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(registrations).toHaveLength(1);
    });
  });

  it('re-registers when the push service rolls the token, with nobody touching anything', async () => {
    await renderPush();

    await waitFor(() => {
      expect(registrations).toHaveLength(1);
    });

    mockRotation.fire?.();

    await waitFor(() => {
      expect(registrations).toHaveLength(2);
    });
  });

  it('drops the rotation subscription when the tree goes away', async () => {
    const { unmount } = await renderPush();

    await waitFor(() => {
      expect(mockRotation.fire).not.toBeNull();
    });

    await unmount();

    expect(mockRotation.removed).toBe(true);
  });

  it('surfaces nothing and throws nothing when registration fails', async () => {
    installTransport(500);

    await renderPush();

    await waitFor(() => {
      expect(registrations).toHaveLength(1);
    });
    // The assertion is the absence of a rejection: an unhandled one fails the
    // suite, and a thrown one would have taken the render with it. Nothing is
    // retried and nothing is shown — the next launch tries again.
  });
});
