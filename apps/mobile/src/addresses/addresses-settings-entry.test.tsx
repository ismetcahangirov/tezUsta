import { fireEvent, render, screen } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { Settings } from '../settings';
import { type AppStore } from '../store';
import { createTestStore } from '../../test/support/test-store';
import { roleSelected } from '../store/session-slice';

/**
 * This lives in the addresses module because what it covers is issue #90's own
 * requirement — that the saved-addresses screen is reachable from wherever the
 * customer's profile lives — rather than anything else about settings.
 *
 * It used to import the route, and imports the component since issue #164:
 * settings is now rendered by two routes (a customer tab and the shared one a
 * master pushes), and this assertion is about neither of them.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

async function mount(store: AppStore): Promise<void> {
  await render(
    <Provider store={store}>
      <Settings />
    </Provider>,
  );
}

describe('the addresses entry point on the settings screen', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('offers "Ünvanlarım" to a customer, and takes them to the addresses route', async () => {
    // The default role in a fresh store is already 'customer'.
    await mount(createTestStore());

    const button = screen.getByRole('button', { name: 'Ünvanlarım' });
    await fireEvent.press(button);

    expect(mockPush).toHaveBeenCalledWith('/(customer)/addresses');
  });

  it('does not offer it to a master — addresses are a customer concept', async () => {
    const store = createTestStore();
    store.dispatch(roleSelected('master'));
    await mount(store);

    expect(screen.queryByRole('button', { name: 'Ünvanlarım' })).not.toBeOnTheScreen();
  });
});
