import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { DeviceDescription, PushPlatform } from './device-registration';
import { NOTIFICATION_CHANNELS, type ChannelAlertLevel } from './notification-channels';
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
 * **The channel table is not here.** `notification-channels.ts` owns it,
 * because that file has no vendor import — which is what lets a test read the
 * table without loading `expo-notifications`, a module that throws in Expo Go on
 * Android. This file is the only place an alert level becomes an
 * `AndroidImportance`; see `ensureChannels` below.
 */

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

/**
 * Creates every channel in {@link NOTIFICATION_CHANNELS}, on Android only.
 *
 * **Sequential rather than `Promise.all`, and that is not caution.** Android
 * lists channels in the order they were created, and that list is the settings
 * screen a user reads; firing five creations concurrently would leave the order
 * up to whichever native call returned first, differing between installs.
 *
 * Creating a channel that already exists updates its **name** and nothing else —
 * importance, sound and vibration are frozen at creation, so a phone that
 * already has these channels keeps whatever it (or its owner) set. That is why
 * `notification-channels.ts` treats the ids as permanent, and why this function
 * is safe to run on every launch.
 */
async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const module = notifications();

  /**
   * The one place a decision becomes a vendor constant.
   *
   * `HIGH` is what makes a notification arrive as a heads-up banner with a
   * sound; `DEFAULT` still makes a sound but stays in the tray. Neither is
   * `LOW`: nothing this product sends is worth silencing on the app's behalf,
   * and a channel the user can switch off is the right place for that decision.
   */
  const importanceOf = {
    'heads-up': module.AndroidImportance.HIGH,
    'sound-only': module.AndroidImportance.DEFAULT,
  } as const satisfies Record<ChannelAlertLevel, number>;

  for (const channel of NOTIFICATION_CHANNELS) {
    await module.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance: importanceOf[channel.alertLevel],
    });
  }
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
