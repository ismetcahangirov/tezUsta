import { act, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { Provider } from 'react-redux';

import { createAppStore, type AppStore } from '../store';
import { roleSelected, signedIn, signedOut } from '../store/session-slice';

import { useAuthGuard } from './useAuthGuard';

const mockReplace = jest.fn();
let mockSegments: string[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSegments: () => mockSegments,
}));

/** A screen that does nothing but sit inside a group and be guarded. */
function Probe(): React.JSX.Element {
  useAuthGuard();
  return <View testID="probe" />;
}

async function mount(store: AppStore, group: string): Promise<void> {
  mockSegments = [group];
  await render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  );
}

function signedInStore(roles: ('customer' | 'master')[]): AppStore {
  const store = createAppStore();
  store.dispatch(signedIn({ userId: 'user-1', roles }));
  return store;
}

describe('guarding a route', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSegments = [];
  });

  it('leaves a restoring session alone', async () => {
    await mount(createAppStore(), '(customer)');

    // The stored refresh token has not been traded yet. Nobody knows where
    // this user belongs, so nothing moves them.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('sends a signed-out user to sign-in', async () => {
    const store = createAppStore();
    store.dispatch(signedOut());

    await mount(store, '(customer)');

    expect(mockReplace).toHaveBeenCalledWith('/(auth)/sign-in');
  });

  it('leaves a signed-out user on the sign-in screen', async () => {
    const store = createAppStore();
    store.dispatch(signedOut());

    await mount(store, '(auth)');

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('keeps a customer out of the master group', async () => {
    await mount(signedInStore(['customer']), '(master)');

    expect(mockReplace).toHaveBeenCalledWith('/(customer)');
  });

  it('keeps a master out of the customer group', async () => {
    await mount(signedInStore(['master']), '(customer)');

    expect(mockReplace).toHaveBeenCalledWith('/(master)');
  });

  it('leaves a customer in their own group', async () => {
    await mount(signedInStore(['customer']), '(customer)');

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('takes a signed-in user out of the auth group', async () => {
    await mount(signedInStore(['master']), '(auth)');

    expect(mockReplace).toHaveBeenCalledWith('/(master)');
  });

  it('leaves either role in the shared group', async () => {
    await mount(signedInStore(['customer', 'master']), '(shared)');

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('moves a dual-role user across when they switch role, without signing in again', async () => {
    const store = signedInStore(['customer', 'master']);
    await mount(store, '(customer)');
    expect(mockReplace).not.toHaveBeenCalled();

    // `act` so React flushes the effect the dispatch schedules; awaited
    // because an un-awaited async act leaves a scope open that swallows every
    // later render in the file.
    await act(async () => {
      await Promise.resolve(store.dispatch(roleSelected('master')));
    });

    // No token was reissued and nothing was re-authenticated: both roles were
    // already granted on this session. The redirect is issued from an effect,
    // so it is waited for rather than asserted on the spot.
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(master)');
    });
  });

  it('does not redirect a second time while the destination has not changed', async () => {
    const store = signedInStore(['customer']);
    await mount(store, '(master)');
    expect(mockReplace).toHaveBeenCalledWith('/(customer)');

    // Re-selecting the role the user already has changes nothing about where
    // they belong, and must not re-issue a navigation they may already have
    // moved on from.
    await act(async () => {
      await Promise.resolve(store.dispatch(roleSelected('customer')));
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });
});
