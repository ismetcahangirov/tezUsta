import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { DeviceDescription, PushPlatform } from './device-registration';
import { notificationsCopy } from './notifications-copy';
import { readPushPermission, type PushPermission } from './push-permission';

/**
 * The only file in the app that reaches for `expo-notifications`.
 *
 * Everything the vendor is awkward about is absorbed here — a runtime that
 * throws rather than degrading, a permission report that must be read through
 * its iOS field, an ordering Android enforces, a token call that is a network
 * request. What the rest of the app sees is `PushPlatform`, which has no vendor
 * type in it and can be substituted in a test (CLAUDE.md §2).
 */

/**
 * The vendor's shape. `import type` is erased at compile time, so naming it
 * here costs no runtime import — which is the whole point below.
 */
type NotificationsModule = typeof ExpoNotifications;

/**
 * The Android channel notifications are delivered on.
 *
 * **One channel, and it has to match `defaultChannel` in the app config.**
 * The server does not set `channelId` on the messages it sends
 * (`apps/api/src/modules/notifications/notification-delivery.service.ts`), so
 * FCM applies the manifest's default — which the `expo-notifications` config
 * plugin writes from that option. A channel created here under any other id
 * would exist, be listed in the phone's settings, and never receive anything.
 *
 * Per-category channels — an offer alerting while a status change stays quiet
 * — need the server to address them, and that is a change to the sender
 * rather than to this file.
 */
export const DEFAULT_CHANNEL_ID = 'default';

/**
 * Whether this runtime can receive a remote notification at all.
 *
 * **Expo Go is not a degraded surface here, it is a throwing one.** From SDK
 * 55 `expo-notifications` raises rather than warns when an Android app running
 * in Expo Go touches push, so this is what keeps Expo Go usable for everything
 * else in the app. A development build is the documented requirement for push.
 */
function isPushSupported(): boolean {
  return !isRunningInExpoGo() && Platform.OS !== 'web';
}

/**
 * `expo-notifications`, loaded on first use rather than at import.
 *
 * **A static import would crash Expo Go on Android before any guard of ours
 * could run.** The module registers a device-token listener at module scope
 * (`DevicePushTokenAutoRegistration.fx.ts`), that listener calls
 * `warnOfExpoGoPushUsage`, and that function *throws* on Android under Expo
 * Go — read out of the shipped `expo-notifications@57.0.20`, not inferred.
 * Importing it would therefore take down a development surface that has
 * nothing to do with push.
 *
 * Every caller below is behind `isPushSupported()`, so the require only
 * happens where the module is safe to load.
 */
function notifications(): NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import throws at load time in Expo Go on Android; see the comment above.
  return require('expo-notifications') as NotificationsModule;
}

/**
 * Decides what happens to a notification that arrives while the app is open.
 *
 * Called at the root layout's module scope rather than in an effect: Expo
 * delivers to whatever handler is installed when the notification arrives, and
 * one installed during a render can miss the notification that launched that
 * render.
 *
 * **It answers synchronously, on purpose.** Expo discards a notification whose
 * handler has not responded within three seconds, so anything that awaited a
 * request here would drop notifications on a slow connection — the exact
 * condition under which they matter most.
 *
 * `shouldShowBanner` and `shouldShowList` rather than `shouldShowAlert`: the
 * single flag was split in `expo-notifications@0.31.0` and is deprecated in the
 * version installed here.
 */
export function configureForegroundPresentation(): void {
  if (!isPushSupported()) {
    return;
  }

  notifications().setNotificationHandler({
    // `Promise.resolve` rather than an `async` function, so the behaviour is
    // already settled when Expo asks for it: the three-second budget above is
    // not a deadline this handler should spend any of.
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
  });
}

async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const module = notifications();

  await module.setNotificationChannelAsync(DEFAULT_CHANNEL_ID, {
    name: notificationsCopy.defaultChannelName,
    // `HIGH` is what makes a notification arrive as a heads-up rather than
    // silently in the tray. Every notification this product sends is about
    // something the recipient is waiting on — an offer expires, a master is
    // outside — so the system default would be wrong for all of them.
    importance: module.AndroidImportance.HIGH,
  });
}

async function getPermission(): Promise<PushPermission> {
  return readPushPermission(await notifications().getPermissionsAsync());
}

async function requestPermission(): Promise<PushPermission> {
  return readPushPermission(await notifications().requestPermissionsAsync());
}

async function acquireToken(): Promise<string> {
  // Called with no arguments so the library resolves the project id the way it
  // documents — `Constants.easConfig` first, then `extra.eas.projectId`. A
  // build with neither throws `ERR_NOTIFICATIONS_NO_EXPERIENCE_ID`, which is
  // the honest outcome: there is no token to be had until an EAS project
  // exists, and `registerPushDevice` reports it as `token-unavailable` rather
  // than as a failure anybody needs to see.
  const { data } = await notifications().getExpoPushTokenAsync();

  return data;
}

function describeDevice(): DeviceDescription {
  return {
    // `PushPlatform` is only reached when `isPushSupported()` held, so web is
    // already excluded and the remaining platforms are the two the contract
    // knows about.
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    deviceId: Constants.deviceName,
    appVersion: Constants.expoConfig?.version,
  };
}

export const expoPushPlatform: PushPlatform = {
  isSupported: isPushSupported(),
  ensureChannels,
  getPermission,
  requestPermission,
  acquireToken,
  describeDevice,
};

/**
 * Calls back when the push service rolls this device's token.
 *
 * **What it emits is the device's FCM/APNs token, not the Expo one** — the
 * listener exists for apps that talk to those services directly. Because we
 * send through Expo's push service, the `ExpoPushToken` string normally
 * survives a rotation: Expo re-points it server-side from its own listener.
 *
 * It is still subscribed to, because "normally" is not "always" and the cost
 * of being wrong is a phone that silently stops receiving. The caller
 * re-acquires the Expo token and registers it again; registration is
 * idempotent on the token server-side, so the common case costs one request
 * and the rare case repairs a phone that would otherwise have gone quiet.
 *
 * The listener deliberately receives no argument: the device token it carries
 * is not a value this app has anywhere to put, and passing it on would invite
 * somebody to send it to `POST /devices`, which expects the other one.
 */
export function addPushTokenRotationListener(onRotation: () => void): { remove: () => void } {
  if (!isPushSupported()) {
    // `addPushTokenListener` is one of the calls that throw in Expo Go on
    // Android, and the module that provides it is loaded by reaching for it.
    return { remove: () => undefined };
  }

  return notifications().addPushTokenListener(() => {
    onRotation();
  });
}

/**
 * Calls back with the payload of every notification the user taps, including
 * the one that launched the app.
 *
 * **One subscription, both entry paths, and that is the point.** A tap from
 * the background arrives through the response listener; a tap that cold-starts
 * the app is waiting in `getLastNotificationResponse()` before any listener
 * could have been attached. Two call sites for those would be two code paths
 * that drift, and the cold-start one is the one nobody opens the app cold
 * enough to notice. Reading the stored response first and then subscribing is
 * what collapses them into one.
 *
 * The callback receives `content.data` and nothing else — not the response,
 * not the notification. The caller's job is to decide whether that payload
 * means anything, and handing it more would invite it to trust more.
 */
export function subscribeToNotificationTaps(onTap: (data: unknown) => void): {
  remove: () => void;
} {
  if (!isPushSupported()) {
    return { remove: () => undefined };
  }

  const module = notifications();

  const launchResponse = module.getLastNotificationResponse();
  if (launchResponse !== null) {
    onTap(launchResponse.notification.request.content.data);
  }

  const subscription = module.addNotificationResponseReceivedListener((response) => {
    onTap(response.notification.request.content.data);
  });

  return {
    remove: () => {
      subscription.remove();
    },
  };
}

/**
 * Forgets the stored tap, so it is not acted on twice.
 *
 * Without this, the response that launched the app is still the "last
 * response" on the next mount — a remount after a fast refresh, or a root
 * layout that re-mounts — and the app would navigate again to a screen the
 * user had already moved away from.
 */
export function forgetLastNotificationTap(): void {
  if (!isPushSupported()) {
    return;
  }

  notifications().clearLastNotificationResponse();
}
