/**
 * What the app may do about notifications, reduced to the three answers it can
 * act on.
 *
 * The platform reports more than three states, and most of the extra detail is
 * about *how* a notification may be presented rather than *whether* one may be
 * sent. A call site only ever needs to know: send, ask, or leave it alone.
 */
export type PushPermission =
  /** Notifications may be delivered. Register the device. */
  | 'granted'
  /** Never asked, and a prompt would be shown. The one moment to ask. */
  | 'askable'
  /** Refused, or refused and unaskable. Say nothing and never prompt again. */
  | 'blocked';

/**
 * The shape this module reads, declared here rather than imported.
 *
 * It is structurally satisfied by `expo-notifications`'
 * `NotificationPermissionsStatus`, so the adapter passes that object straight
 * in — but nothing in this file imports the vendor, which is what keeps it a
 * pure function with no native module behind it (CLAUDE.md §2: the interface
 * is designed as if it were already a package).
 */
export interface RawPushPermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  readonly ios?: { readonly status: number } | undefined;
}

/**
 * `IosAuthorizationStatus`, transcribed from the shipped
 * `expo-notifications@57.0.20` — `build/NotificationPermissions.types.d.ts`:
 *
 * ```ts
 * export declare enum IosAuthorizationStatus {
 *   NOT_DETERMINED = 0, DENIED = 1, AUTHORIZED = 2, PROVISIONAL = 3, EPHEMERAL = 4
 * }
 * ```
 *
 * Transcribed rather than imported because importing the enum is importing the
 * native module, and this file exists to be testable without one.
 */
const IOS_NOT_DETERMINED = 0;
const IOS_AUTHORIZED = 2;
const IOS_PROVISIONAL = 3;
const IOS_EPHEMERAL = 4;

/**
 * Reduces a platform permission report to the answer the app acts on.
 *
 * **On iOS, `ios.status` is the authority and the root `granted` is not.**
 * Expo documents this directly ("you should rely on the
 * `NotificationPermissionsStatus`'s `ios.status` field, instead of the root
 * `status` field"), and the case that proves it is `PROVISIONAL`: a
 * provisionally authorised app delivers quietly to the notification centre
 * while reporting `granted: false`. Reading the root field would prompt a user
 * whose notifications already work.
 *
 * **An unrecognised iOS status is `blocked`, not `askable`.** The two answers
 * are not symmetric — being wrong about `blocked` shows the user nothing,
 * being wrong about `askable` shows them a dialog for no reason, and on iOS a
 * dialog spent on the wrong moment is spent permanently.
 */
export function readPushPermission(raw: RawPushPermission): PushPermission {
  if (raw.ios !== undefined) {
    switch (raw.ios.status) {
      case IOS_AUTHORIZED:
      case IOS_PROVISIONAL:
      case IOS_EPHEMERAL:
        return 'granted';
      case IOS_NOT_DETERMINED:
        return 'askable';
      default:
        return 'blocked';
    }
  }

  if (raw.granted) {
    return 'granted';
  }

  // Android below API 33 reports `canAskAgain` as "notifications are enabled"
  // rather than as a request-again signal, so a user who turned them off in
  // system settings arrives here as blocked. That is the right answer for both
  // readings: there is no prompt to show them either way.
  return raw.canAskAgain ? 'askable' : 'blocked';
}
