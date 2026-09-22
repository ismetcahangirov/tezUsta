import { act, renderHook } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { registeredDevice } from '../notifications/registered-device';
import { signedIn } from '../store/session-slice';
import { useSignOut, useSignOutEverywhere } from './useSignOut';

/**
 * Every secure-storage deletion, so a test can place it against the requests.
 *
 * Referenced from inside the mocked function rather than from the factory
 * body: `jest.mock` is hoisted above this declaration, and only the call
 * happens late enough for the binding to exist.
 */
const mockSecureStoreCalls: string[] = [];

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(() => {
    mockSecureStoreCalls.push('clear');
    return Promise.resolve();
  }),
}));

/** Every request the hook caused, in the order the transport saw it. */
let requests: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);

    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

  return <Provider store={store}>{children}</Provider>;
}

describe('useSignOut', () => {
  beforeEach(() => {
    requests = [];
    mockSecureStoreCalls.length = 0;
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });
    installTransport();
  });

  afterEach(() => {
    registeredDevice.forget();
  });

  it('retires the device before it revokes the session', async () => {
    // The order is the requirement. The server re-reads the session on every
    // request, so a retirement sent after the logout is a retirement that 401s.
    const { result } = await renderHook(() => useSignOut(), { wrapper });

    await act(async () => {
      await result.current[0]();
    });

    expect(requests).toEqual(['DELETE /devices/device-1', 'POST /auth/logout']);
  });

  it('retires the device before the tokens leave secure storage', async () => {
    const { result } = await renderHook(() => useSignOut(), { wrapper });

    await act(async () => {
      await result.current[0]();
    });

    expect(requests[0]).toBe('DELETE /devices/device-1');
    expect(mockSecureStoreCalls.length).toBeGreaterThan(0);
  });

  it('forgets the device, so the next user on this phone inherits no id', async () => {
    const { result } = await renderHook(() => useSignOut(), { wrapper });

    await act(async () => {
      await result.current[0]();
    });

    expect(registeredDevice.current()).toBeNull();
  });

  it('signs out anyway when the device could not be retired', async () => {
    global.fetch = ((input: Request | string): Promise<Response> => {
      const request = typeof input === 'string' ? new Request(input) : input;
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);

      if (request.method === 'DELETE') {
        return Promise.reject(new TypeError('Network request failed'));
      }

      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const { result } = await renderHook(() => useSignOut(), { wrapper });

    await act(async () => {
      await result.current[0]();
    });

    expect(requests).toContain('POST /auth/logout');
    expect(mockSecureStoreCalls.length).toBeGreaterThan(0);
  });

  it('signs out a device that never registered without calling the registry', async () => {
    registeredDevice.forget();

    const { result } = await renderHook(() => useSignOut(), { wrapper });

    await act(async () => {
      await result.current[0]();
    });

    expect(requests).toEqual(['POST /auth/logout']);
  });
});

describe('useSignOutEverywhere', () => {
  beforeEach(() => {
    requests = [];
    mockSecureStoreCalls.length = 0;
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });
    installTransport();
  });

  afterEach(() => {
    registeredDevice.forget();
  });

  it('retires this device before revoking every session', async () => {
    const { result } = await renderHook(() => useSignOutEverywhere(), { wrapper });

    await act(async () => {
      await result.current[0]();
    });

    expect(requests).toEqual(['DELETE /devices/device-1', 'POST /auth/logout-all']);
  });
});
