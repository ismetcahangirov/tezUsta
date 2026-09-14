import * as SecureStore from 'expo-secure-store';

import {
  clearSecureStorage,
  deleteSecureItem,
  getSecureItem,
  SECURE_KEYS,
  setSecureItem,
} from './secure-store';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mocked = jest.mocked(SecureStore);

describe('secure storage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('round-trips a value', async () => {
    mocked.setItemAsync.mockResolvedValue(undefined);
    mocked.getItemAsync.mockResolvedValue('a-token');

    await setSecureItem(SECURE_KEYS.accessToken, 'a-token');

    await expect(getSecureItem(SECURE_KEYS.accessToken)).resolves.toBe('a-token');
    expect(mocked.setItemAsync).toHaveBeenCalledWith(SECURE_KEYS.accessToken, 'a-token');
  });

  it('reports a missing item as null', async () => {
    mocked.getItemAsync.mockResolvedValue(null);

    await expect(getSecureItem(SECURE_KEYS.refreshToken)).resolves.toBeNull();
  });

  it('returns null instead of throwing when the keychain is unreadable', async () => {
    mocked.getItemAsync.mockRejectedValue(new Error('keychain unavailable'));

    await expect(getSecureItem(SECURE_KEYS.accessToken)).resolves.toBeNull();
  });

  it('deletes an item', async () => {
    mocked.deleteItemAsync.mockResolvedValue(undefined);

    await deleteSecureItem(SECURE_KEYS.accessToken);

    expect(mocked.deleteItemAsync).toHaveBeenCalledWith(SECURE_KEYS.accessToken);
  });

  it('clears every secret the app owns on sign-out', async () => {
    mocked.deleteItemAsync.mockResolvedValue(undefined);

    await clearSecureStorage();

    for (const key of Object.values(SECURE_KEYS)) {
      expect(mocked.deleteItemAsync).toHaveBeenCalledWith(key);
    }
  });
});
