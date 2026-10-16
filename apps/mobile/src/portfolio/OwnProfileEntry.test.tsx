import { render, screen, userEvent } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { OwnProfileEntry } from './OwnProfileEntry';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

describe('OwnProfileEntry', () => {
  it('is the master’s avatar, read as "Profilim", and opens their profile', async () => {
    global.fetch = () =>
      Promise.resolve(
        Response.json({ id: 'master-1', displayName: 'Elvin Məmmədov', avatarUrl: null }),
      );
    const onPress = jest.fn();
    await render(
      <Provider store={createTestStore()}>
        <OwnProfileEntry onPress={onPress} />
      </Provider>,
    );

    await userEvent.press(await screen.findByRole('button', { name: copy.own.title }));

    expect(onPress).toHaveBeenCalled();
    expect(screen.getByText('EM', { includeHiddenElements: true })).toBeOnTheScreen();
  });
});
