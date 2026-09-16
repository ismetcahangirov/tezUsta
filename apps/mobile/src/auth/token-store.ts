import { clearSecureStorage, getSecureItem, SECURE_KEYS, setSecureItem } from '../lib/secure-store';

import type { TokenPairResponse } from './auth.types';

/**
 * The one place tokens live.
 *
 * | Token   | Where            | Why                                          |
 * | ------- | ---------------- | -------------------------------------------- |
 * | Access  | this module's memory | 15-minute life, re-mintable from the refresh token. Persisting it buys nothing and widens the at-rest surface |
 * | Refresh | `expo-secure-store` | Keychain / Keystore, hardware-backed where available |
 *
 * **`AsyncStorage` is forbidden for either** (CLAUDE.md §11, §20). It is
 * unencrypted plaintext on the filesystem, readable by any process on a rooted
 * or jailbroken device. It is not a dependency of this app and must not become
 * one for this purpose.
 *
 * A module-level variable, not a Redux slice: the base query reads the access
 * token on every request including the replay after a refresh, and a value
 * read through the store would make the transport depend on React's render
 * cycle for a string that has nothing to do with rendering. The slice holds
 * the *flag* — whether there is a session — which is what screens react to
 * (docs/architecture/frontend-architecture.md § State management).
 */
let accessToken: string | null = null;

export interface TokenStore {
  /** Synchronous by design — it is read while building every request. */
  getAccessToken(): string | null;
  getRefreshToken(): Promise<string | null>;
  save(pair: TokenPairResponse): Promise<void>;
  clear(): Promise<void>;
}

export const tokenStore: TokenStore = {
  getAccessToken() {
    return accessToken;
  },

  getRefreshToken() {
    return getSecureItem(SECURE_KEYS.refreshToken);
  },

  /**
   * The keychain write happens **before** the in-memory assignment, so a
   * failed write rejects with nothing stored anywhere. The other order would
   * leave the user apparently signed in against a token that vanishes at the
   * next cold start, which presents as "the app randomly signs me out" and is
   * nearly impossible to diagnose from a bug report.
   */
  async save(pair) {
    await setSecureItem(SECURE_KEYS.refreshToken, pair.refreshToken);
    accessToken = pair.accessToken;
  },

  /**
   * `clearSecureStorage` deletes every key this app owns, including the unused
   * `SECURE_KEYS.accessToken`. Nothing writes that key — see the table above —
   * but a build that once did would have left a token behind, and sign-out is
   * the moment to be rid of it.
   */
  async clear() {
    accessToken = null;
    await clearSecureStorage();
  },
};
