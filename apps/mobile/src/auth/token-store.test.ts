import * as SecureStore from 'expo-secure-store';

import { SECURE_KEYS } from '../lib/secure-store';

import { tokenStore } from './token-store';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/**
 * `@react-native-async-storage/async-storage` is **not** a dependency of this
 * app, and mocking it virtually is the point: if anybody ever adds it and
 * reaches for it here, this mock starts recording calls and these assertions
 * fail. Reading the source for the absence of an import would prove nothing
 * about a helper three files away.
 *
 * Tokens in `AsyncStorage` are unencrypted plaintext on the filesystem,
 * readable by any process on a rooted or jailbroken device (CLAUDE.md §11,
 * §20; docs/architecture/authentication.md § Storage).
 */
const mockAsyncStorage = {
  setItem: jest.fn(),
  getItem: jest.fn(),
  removeItem: jest.fn(),
  multiSet: jest.fn(),
};

jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage, { virtual: true });

const secureStore = jest.mocked(SecureStore);

const PAIR = {
  accessToken: 'header.payload.signature',
  accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
  refreshToken: 'row-id.secret-half',
  refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
};

describe('token storage', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
    secureStore.getItemAsync.mockResolvedValue(null);

    // The access token is module state; a suite that left one behind would
    // make the next test pass for the wrong reason.
    await tokenStore.clear();
    jest.clearAllMocks();
  });

  it('puts the refresh token in the keychain', async () => {
    await tokenStore.save(PAIR);

    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      SECURE_KEYS.refreshToken,
      PAIR.refreshToken,
    );
  });

  it('never writes a token to AsyncStorage', async () => {
    await tokenStore.save(PAIR);
    await tokenStore.getRefreshToken();
    await tokenStore.clear();

    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.multiSet).not.toHaveBeenCalled();
    expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('keeps the access token in memory and out of the keychain', async () => {
    await tokenStore.save(PAIR);

    expect(tokenStore.getAccessToken()).toBe(PAIR.accessToken);
    expect(secureStore.setItemAsync).not.toHaveBeenCalledWith(
      SECURE_KEYS.accessToken,
      expect.anything(),
    );
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('reads the refresh token back out of the keychain', async () => {
    secureStore.getItemAsync.mockResolvedValue(PAIR.refreshToken);

    await expect(tokenStore.getRefreshToken()).resolves.toBe(PAIR.refreshToken);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(SECURE_KEYS.refreshToken);
  });

  it('stores nothing at all when the keychain write fails', async () => {
    secureStore.setItemAsync.mockRejectedValue(new Error('keychain locked'));

    await expect(tokenStore.save(PAIR)).rejects.toThrow('keychain locked');

    // The alternative order presents as "the app randomly signs me out": the
    // session looks live until the next cold start finds nothing to restore.
    expect(tokenStore.getAccessToken()).toBeNull();
  });

  it('clears both the memory and the keychain on sign-out', async () => {
    await tokenStore.save(PAIR);

    await tokenStore.clear();

    expect(tokenStore.getAccessToken()).toBeNull();
    for (const key of Object.values(SECURE_KEYS)) {
      expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(key);
    }
  });
});
