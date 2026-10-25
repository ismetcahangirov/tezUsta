import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import type * as NativeWind from 'nativewind';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type * as SecureStoreModule from '../lib/secure-store';
import { Settings } from '../settings/Settings';
import { SETTINGS_COPY } from '../settings/settings-copy';
import type * as SchemePreferenceModule from './scheme-preference';

/**
 * The appearance control (found on the A36 on 25 October 2026): "Sistem" lit
 * "İşıqlı" on a light phone, and no choice outlived the app. What is asserted
 * is what the person sees on the control and what the next launch restores.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const KEY = 'tezusta.color-scheme';

type PreferenceModule = typeof SchemePreferenceModule;

/**
 * A fresh copy of the module, so one test's choice is not the next one's start,
 * with a spy on the `colorScheme.set` that copy actually calls (an isolated
 * registry loads its own `nativewind`).
 */
function freshModule(): { preference: PreferenceModule; set: jest.SpyInstance } {
  let loaded: { preference: PreferenceModule; set: jest.SpyInstance } | undefined;
  jest.isolateModules(() => {
    const nativewind = jest.requireActual<typeof NativeWind>('nativewind');
    loaded = {
      set: jest.spyOn(nativewind.colorScheme, 'set'),
      preference: jest.requireActual<PreferenceModule>('./scheme-preference'),
    };
  });
  if (loaded === undefined) throw new Error('scheme-preference did not load');
  return loaded;
}

function selected(label: string): boolean | undefined {
  const control = screen.getByLabelText(label);
  return (control.props as { accessibilityState?: { selected?: boolean } }).accessibilityState
    ?.selected;
}

beforeEach(() => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  jest.mocked(SecureStore.setItemAsync).mockClear();
  global.fetch = () =>
    Promise.resolve(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
});

describe('the appearance control', () => {
  it('shows "Sistem" as chosen after tapping it, even on a light phone', async () => {
    await render(
      <Provider store={createTestStore()}>
        <Settings />
      </Provider>,
    );

    await fireEvent.press(screen.getByLabelText(SETTINGS_COPY.schemeDark));
    expect(selected(SETTINGS_COPY.schemeDark)).toBe(true);

    await fireEvent.press(screen.getByLabelText(SETTINGS_COPY.schemeSystem));
    expect(selected(SETTINGS_COPY.schemeSystem)).toBe(true);
    expect(selected(SETTINGS_COPY.schemeLight)).toBe(false);
  });

  it('keeps the choice for the next launch', async () => {
    await render(
      <Provider store={createTestStore()}>
        <Settings />
      </Provider>,
    );

    await fireEvent.press(screen.getByLabelText(SETTINGS_COPY.schemeDark));

    expect(SecureStore.setItemAsync).toHaveBeenLastCalledWith(KEY, 'dark');
  });
});

describe('restoring the choice at launch', () => {
  it('applies a stored dark choice and reports it', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue('dark');
    const { preference, set } = freshModule();

    await preference.restoreSchemePreference();

    expect(set).toHaveBeenCalledWith('dark');
  });

  it('follows the phone, untouched, when nothing or nonsense is stored', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('purple');
    const { preference, set } = freshModule();

    await preference.restoreSchemePreference();

    expect(set).not.toHaveBeenCalled();
  });

  it('survives a store that cannot be read', async () => {
    jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keystore'));
    const { preference } = freshModule();

    await expect(preference.restoreSchemePreference()).resolves.toBeUndefined();
  });

  it('shows the restored choice on the control', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue('system');
    const { restoreSchemePreference } = jest.requireActual<PreferenceModule>('./scheme-preference');
    await restoreSchemePreference();

    await render(
      <Provider store={createTestStore()}>
        <Settings />
      </Provider>,
    );

    await waitFor(() => {
      expect(selected(SETTINGS_COPY.schemeSystem)).toBe(true);
    });
  });
});

describe('signing out', () => {
  it('leaves the appearance choice in place', async () => {
    const { clearSecureStorage } =
      jest.requireActual<typeof SecureStoreModule>('../lib/secure-store');
    await clearSecureStorage();

    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith(KEY);
  });
});
