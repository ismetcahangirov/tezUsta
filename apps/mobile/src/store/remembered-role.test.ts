import * as SecureStore from 'expo-secure-store';

import { createTestStore } from '../../test/support/test-store';
import { DEVICE_SETTING_KEYS } from '../lib/secure-store';

import { readRememberedRole, rememberRole } from './remembered-role';
import { roleSelected, signedIn } from './session-slice';

jest.mock('expo-secure-store', () => {
  const items = new Map<string, string>();
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(items.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      items.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      items.delete(key);
      return Promise.resolve();
    }),
    __items: items,
  };
});

const items = (SecureStore as unknown as { __items: Map<string, string> }).__items;

/** Lets the listener's queued SecureStore write finish. */
function flushWrites(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  items.clear();
});

describe('the remembered role', () => {
  it('reads back what was remembered for the same user', async () => {
    await rememberRole('user-1', 'master');

    await expect(readRememberedRole('user-1')).resolves.toBe('master');
  });

  it('never hands one user the role another user chose', async () => {
    await rememberRole('user-1', 'master');

    await expect(readRememberedRole('user-2')).resolves.toBeNull();
  });

  it('is nothing when nobody is signed in, or nothing was stored', async () => {
    await expect(readRememberedRole(null)).resolves.toBeNull();
    await expect(readRememberedRole('user-1')).resolves.toBeNull();
  });

  it('ignores a stored value it cannot read', async () => {
    items.set(DEVICE_SETTING_KEYS.activeRole, '{"userId":"user-1","role":"admin"}');
    await expect(readRememberedRole('user-1')).resolves.toBeNull();

    items.set(DEVICE_SETTING_KEYS.activeRole, 'not json');
    await expect(readRememberedRole('user-1')).resolves.toBeNull();
  });

  it('keeps the last of several quick choices', async () => {
    void rememberRole('user-1', 'master');
    await rememberRole('user-1', 'customer');

    await expect(readRememberedRole('user-1')).resolves.toBe('customer');
  });
});

describe('saving the choice from the store', () => {
  it('saves a role chosen while signed in', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer', 'master'] }));

    store.dispatch(roleSelected('master'));
    await flushWrites();

    await expect(readRememberedRole('user-1')).resolves.toBe('master');
  });

  it('saves nothing for a choice made before anyone is signed in', async () => {
    const store = createTestStore();

    store.dispatch(roleSelected('master'));
    await flushWrites();

    expect(items.has(DEVICE_SETTING_KEYS.activeRole)).toBe(false);
  });
});
