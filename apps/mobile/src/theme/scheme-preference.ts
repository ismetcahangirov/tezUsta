import { colorScheme } from 'nativewind';
import { useSyncExternalStore } from 'react';

import { DEVICE_SETTING_KEYS, getSecureItem, setSecureItem } from '../lib/secure-store';

/** What the person chose on the appearance control. */
export type SchemePreference = 'light' | 'dark' | 'system';

/**
 * The appearance the person **chose**, kept apart from the scheme in force.
 *
 * NativeWind's `useColorScheme().colorScheme` answers the scheme being drawn,
 * which is `light` or `dark` and never `system`. The settings control used to
 * show that value, so tapping "Sistem" on a light phone lit "İşıqlı" instead,
 * and the choice was never stored, so "Qaranlıq" lasted only until the app was
 * next opened. This module holds the choice itself, stores it on the phone and
 * re-applies it at launch.
 *
 * A module-level value with `useSyncExternalStore` rather than a context: the
 * root layout restores it before any provider exists, and the settings screen
 * reads it, and both must see the same value.
 */
let current: SchemePreference = 'system';
const listeners = new Set<() => void>();

function publish(next: SchemePreference): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isPreference(value: string | null): value is SchemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The stored choice, or `system` when there is none or it cannot be read. */
export async function restoreSchemePreference(): Promise<void> {
  const stored = await getSecureItem(DEVICE_SETTING_KEYS.colorScheme);
  if (!isPreference(stored)) return;
  publish(stored);
  // `system` needs no call: following the phone is what the app does unasked.
  if (stored === 'system') return;
  try {
    colorScheme.set(stored);
  } catch {
    // Called at module scope in the root layout: a refusal from the platform
    // must leave the app following the phone, not stop it launching.
  }
}

/** Applies a choice now and keeps it for the next launch. */
export function chooseSchemePreference(next: SchemePreference): void {
  publish(next);
  colorScheme.set(next);
  setSecureItem(DEVICE_SETTING_KEYS.colorScheme, next).catch(() => {
    // A keystore that refuses a write costs the choice at the next launch,
    // not the choice now.
  });
}

export function useSchemePreference(): SchemePreference {
  return useSyncExternalStore(subscribe, () => current);
}
