/**
 * What the app may do about location, reduced to the three answers it can act
 * on — the same shape, and for the same reasons, as
 * `src/notifications/push-permission.ts`.
 */
export type LocationPermission =
  /** A position may be read. Start reporting. */
  | 'granted'
  /** Never asked, and a prompt would be shown. The one moment to ask. */
  | 'askable'
  /** Refused, or refused and unaskable. Say what it costs, and never prompt again. */
  | 'blocked';

/**
 * The shape this module reads, declared here rather than imported.
 *
 * It is structurally satisfied by `expo-location`'s
 * `LocationPermissionResponse`, so the adapter passes that object straight in
 * — but nothing in this file imports the vendor, which is what keeps it a pure
 * function with no native module behind it (CLAUDE.md §2).
 */
export interface RawLocationPermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}

/**
 * Reduces a platform permission report to the answer the app acts on.
 *
 * **There is no iOS special case here, and that is the difference from
 * notifications.** `expo-notifications` needs `ios.status` read directly
 * because a *provisional* authorisation delivers quietly while reporting
 * `granted: false`. Location has no equivalent: `expo-location@57.0.19`'s
 * `LocationPermissionResponse` adds `ios.scope` (`'none' | 'foreground' |
 * 'full'`) and `android.scope`, which describe *how much* access was given
 * rather than whether any was — and "how much" is the foreground/background
 * distinction, which this app asks for separately.
 *
 * **`granted` wins over `canAskAgain`.** A granted permission is not askable
 * whatever the second field says, and the order matters because Android
 * reports `canAskAgain: true` alongside a granted permission.
 */
export function readLocationPermission(raw: RawLocationPermission): LocationPermission {
  if (raw.granted) {
    return 'granted';
  }

  return raw.canAskAgain ? 'askable' : 'blocked';
}
