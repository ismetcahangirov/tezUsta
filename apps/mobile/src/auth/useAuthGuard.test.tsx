import { act, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { roleSelected, signedIn, signedOut } from '../store/session-slice';

import { useAuthGuard } from './useAuthGuard';

const mockReplace = jest.fn();
let mockSegments: string[] = [];

/**
 * One object for the whole file, not a fresh one per call.
 *
 * That is what expo-router actually does — `useRouter()` returns the
 * module-level `router` singleton (`build/hooks/useRouter.js`), so its identity
 * is stable across renders and an effect keyed on it does not re-run. A mock
 * that minted a new object per render would re-run every such effect on every
 * render, which makes a guard that reacts to nothing look like a guard that
 * reacts to everything: the regression test below passed against the unfixed
 * hook until this line existed.
 */
const mockRouter = { replace: mockReplace };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
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
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles }));
  return store;
}

describe('guarding a route', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSegments = [];
  });

  it('leaves a restoring session alone', async () => {
    await mount(createTestStore(), '(customer)');

    // The stored refresh token has not been traded yet. Nobody knows where
    // this user belongs, so nothing moves them.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('sends a signed-out user to sign-in', async () => {
    const store = createTestStore();
    store.dispatch(signedOut());

    await mount(store, '(customer)');

    expect(mockReplace).toHaveBeenCalledWith('/(auth)/sign-in');
  });

  it('leaves a signed-out user on the sign-in screen', async () => {
    const store = createTestStore();
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

  it('corrects a route that changed underneath it, not only a destination that changed', async () => {
    // Issue #71, as a unit. A signed-in user is on `(auth)/verify`; the guard
    // sends them to `/(customer)`; something else on the screen then navigates
    // to `(auth)/sign-in` before that lands. Both routes are in `(auth)`, so
    // the guard's answer is `/(customer)` either way — and a guard that only
    // reacts to its own answer changing has nothing left to react to, which is
    // how a valid sign-in ended up back on the sign-in screen.
    mockSegments = ['(auth)', 'verify'];
    const store = signedInStore(['customer']);

    const view = await render(
      <Provider store={store}>
        <Probe />
      </Provider>,
    );

    expect(mockReplace).toHaveBeenCalledWith('/(customer)');
    expect(mockReplace).toHaveBeenCalledTimes(1);

    // The route moved; the destination did not.
    mockSegments = ['(auth)', 'sign-in'];
    await view.rerender(
      <Provider store={store}>
        <Probe />
      </Provider>,
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(2);
    });
    expect(mockReplace).toHaveBeenLastCalledWith('/(customer)');
  });

  it('gives a user with no granted roles somewhere coherent to land', async () => {
    // A brand-new account: the access token carries `roles: []`, which the
    // session slice reads as "not known" rather than as "holds nothing". The
    // guard must still take them out of `(auth)` — leaving them there is the
    // same dead end as the bug above, reached a different way.
    await mount(signedInStore([]), '(auth)');

    expect(mockReplace).toHaveBeenCalledWith('/(customer)');
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
