import { fireEvent, render, screen } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import CustomerSettingsScreen from '../../app/(customer)/(tabs)/settings';
import MasterHomeScreen from '../../app/(master)/index';
import { createTestStore } from '../../test/support/test-store';
import { SETTINGS_COPY } from './settings-copy';

/**
 * Issue #164. Settings existed, was guarded, rendered — and was linked from no
 * screen in the app, in either role. What is asserted here is the way *in*,
 * which is the whole issue; the screen's own behaviour is covered by
 * `addresses-settings-entry.test.tsx` and by the notification tests.
 *
 * Not co-located with the routes: every `.tsx` under `apps/mobile/app` is an
 * expo-router route, so a test file beside one would ship as a route.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();

/**
 * `push` forwards rather than *being* `mockPush`, and that is load-bearing.
 * The factory runs while this file's imports are still being resolved, before
 * `const mockPush` has been initialised — a property assigned then captures
 * `undefined` forever, which is how the master's `router.push` ends up "not a
 * function". A function body reads the binding when it is called instead.
 */
jest.mock('expo-router', () => ({
  router: {
    push: (href: unknown): void => {
      mockPush(href);
    },
  },
  useRouter: () => ({ push: mockPush }),
}));

beforeEach(() => {
  mockPush.mockClear();
  // Both screens hold hooks that read the server. What they get back does not
  // matter here — that an entry point exists does not depend on it — but an
  // unmocked `fetch` would.
  global.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
});

describe('reaching settings', () => {
  it('gives the customer a tab that is the settings screen itself', async () => {
    await render(
      <Provider store={createTestStore()}>
        <CustomerSettingsScreen />
      </Provider>,
    );

    expect(screen.getByText(SETTINGS_COPY.title)).toBeOnTheScreen();
    // The control that had nowhere to be reached from until #164.
    expect(screen.getByRole('button', { name: SETTINGS_COPY.signOut })).toBeOnTheScreen();
  });

  /**
   * The master has no tab bar to hang a tab on (ADR-0030 § 2), so their way in
   * is a control on the one screen they do have — and it must lead to the
   * shared route rather than into the customer's group, which the route guard
   * would bounce them out of.
   */
  it('gives the master a control on their home that opens the shared route', async () => {
    await render(
      <Provider store={createTestStore()}>
        <MasterHomeScreen />
      </Provider>,
    );

    await fireEvent.press(screen.getByRole('button', { name: SETTINGS_COPY.openLabel }));

    expect(mockPush).toHaveBeenCalledWith('/(shared)/settings');
  });
});
