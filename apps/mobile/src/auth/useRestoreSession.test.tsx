import { render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { selectAuthStatus, selectGrantedRoles } from '../store/session-slice';

import type { RefreshCoordinator, RefreshOutcome } from './refresh';
import { useRestoreSession } from './useRestoreSession';

function coordinatorReturning(
  outcome: RefreshOutcome,
): RefreshCoordinator & { calls: () => number } {
  let calls = 0;

  return {
    calls: () => calls,
    refresh() {
      calls += 1;
      return Promise.resolve(outcome);
    },
  };
}

async function mount(store: AppStore, coordinator: RefreshCoordinator): Promise<void> {
  function Probe(): React.JSX.Element {
    useRestoreSession(coordinator);
    return <View testID="probe" />;
  }

  await render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  );
}

describe('restoring a session at launch', () => {
  it('signs the user in from the refresh token in the keychain', async () => {
    const store = createTestStore();

    await mount(
      store,
      coordinatorReturning({
        status: 'refreshed',
        identity: { userId: 'user-1', roles: ['customer', 'master'] },
      }),
    );

    await waitFor(() => {
      expect(selectAuthStatus(store.getState())).toBe('signed-in');
    });
    expect(selectGrantedRoles(store.getState())).toEqual(['customer', 'master']);
  });

  it('signs the user out when there is nothing to restore', async () => {
    const store = createTestStore();

    await mount(store, coordinatorReturning({ status: 'rejected' }));

    await waitFor(() => {
      expect(selectAuthStatus(store.getState())).toBe('signed-out');
    });
  });

  it('signs the user out when the refresh could not be reached', async () => {
    const store = createTestStore();

    await mount(store, coordinatorReturning({ status: 'unavailable' }));

    // The stored token is kept by the coordinator; what the user sees is the
    // sign-in screen, because the alternative is an app that hangs on a blank
    // screen until a timeout. A real "offline, session unknown" state is a
    // product decision nobody has made.
    await waitFor(() => {
      expect(selectAuthStatus(store.getState())).toBe('signed-out');
    });
  });

  it('restores once, not on every render', async () => {
    const store = createTestStore();
    const coordinator = coordinatorReturning({ status: 'rejected' });

    await mount(store, coordinator);

    await waitFor(() => {
      expect(selectAuthStatus(store.getState())).toBe('signed-out');
    });
    expect(coordinator.calls()).toBe(1);
  });
});
