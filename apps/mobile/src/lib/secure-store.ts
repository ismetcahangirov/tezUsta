import * as SecureStore from 'expo-secure-store';

/**
 * Keychain / Keystore-backed storage for anything that must not sit in
 * `AsyncStorage` — tokens above all (CLAUDE.md §11, §20).
 *
 * Reads never throw: a missing or unreadable item is `null`, because a device
 * with a wiped keychain must still reach the sign-in screen rather than crash
 * on launch.
 */
export const SECURE_KEYS = {
  /**
   * **Nothing writes this key.** The access token lives in memory only — it
   * expires in fifteen minutes and is re-mintable from the refresh token, so
   * persisting it would widen the at-rest surface for nothing
   * (docs/architecture/authentication.md § Token model; `src/auth/token-store.ts`).
   * It is retained so that `clearSecureStorage` still deletes a value written
   * by an earlier build.
   */
  accessToken: 'tezusta.access-token',
  refreshToken: 'tezusta.refresh-token',
} as const;

export type SecureKey = (typeof SECURE_KEYS)[keyof typeof SECURE_KEYS];

export async function getSecureItem(key: SecureKey): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // Never log the key's value — see docs/engineering/security.md.
    return null;
  }
}

export async function setSecureItem(key: SecureKey, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecureItem(key: SecureKey): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

/** Clears every secret this app owns. Used on sign-out and on refresh reuse. */
export async function clearSecureStorage(): Promise<void> {
  await Promise.all(Object.values(SECURE_KEYS).map((key) => deleteSecureItem(key)));
}
