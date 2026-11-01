import { createListenerMiddleware } from '@reduxjs/toolkit';

import { DEVICE_SETTING_KEYS, getSecureItem, setSecureItem } from '../lib/secure-store';

import { roleSelected, type AppRole } from './session-slice';

/**
 * The role a two-role user last chose, kept across launches.
 *
 * Without it every cold start opened in the customer role, so a master who
 * also holds the customer grant came back to the customer home, out of the
 * master room, and saw no offers until they switched by hand in Settings.
 *
 * **Stored with the user's id.** The value is read back only for the same
 * user, so a second account signing in on the phone starts from the default
 * rather than from the previous person's choice — the same rule `signedOut`
 * follows for everything else in the session. It stays a preference: the
 * session slice still snaps it onto a granted role in `signedIn`, and the API
 * re-checks the role on every request.
 */
interface StoredRole {
  readonly userId: string;
  readonly role: AppRole;
}

function isAppRole(value: unknown): value is AppRole {
  return value === 'customer' || value === 'master';
}

function parse(raw: string | null): StoredRole | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { userId, role } = value as Record<string, unknown>;
    return typeof userId === 'string' && isAppRole(role) ? { userId, role } : null;
  } catch {
    return null;
  }
}

/** The role this user last chose on this phone, or `null`. Never throws. */
export async function readRememberedRole(userId: string | null): Promise<AppRole | null> {
  if (userId === null) return null;
  const stored = parse(await getSecureItem(DEVICE_SETTING_KEYS.activeRole));
  return stored !== null && stored.userId === userId ? stored.role : null;
}

let pendingWrite: Promise<void> = Promise.resolve();

/**
 * Writes the choice, one write after another so the last choice is the one
 * that lands. A keystore that refuses costs the choice at the next launch, not
 * the choice now.
 */
export function rememberRole(userId: string, role: AppRole): Promise<void> {
  const value: StoredRole = { userId, role };
  pendingWrite = pendingWrite
    .then(() => setSecureItem(DEVICE_SETTING_KEYS.activeRole, JSON.stringify(value)))
    .catch(() => undefined);
  return pendingWrite;
}

/**
 * Saves every role choice made while someone is signed in. A choice made with
 * no user — the restore applying a remembered role before `signedIn` — has
 * nobody to belong to and is not written.
 */
export function createRememberedRoleMiddleware() {
  const listener = createListenerMiddleware();

  listener.startListening({
    actionCreator: roleSelected,
    effect: (action, api) => {
      const { userId } = (api.getState() as { session: { userId: string | null } }).session;
      if (userId !== null) {
        void rememberRole(userId, action.payload);
      }
    },
  });

  return listener.middleware;
}
