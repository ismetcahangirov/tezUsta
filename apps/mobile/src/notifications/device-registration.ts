import type { Device, DevicePlatform, DeviceRegistration } from '@tezusta/types';

import type { PushPermission } from './push-permission';

/** What this device can say about itself when it registers. */
export interface DeviceDescription {
  readonly platform: DevicePlatform;
  /** A human-readable name, so a device list reads "Pixel 7" rather than a uuid. */
  readonly deviceId: string | undefined;
  readonly appVersion: string | undefined;
}

/**
 * Everything registration needs from the platform, and nothing it needs from
 * the vendor.
 *
 * `push-adapter.ts` is the only implementation and the only file that imports
 * `expo-notifications`. Registration is the part with the rules worth testing
 * — an ordering Android 13 enforces, a permission that must not be asked
 * twice, three different ways a token can fail to arrive — and none of that is
 * testable through a native module.
 */
export interface PushPlatform {
  /** False where the runtime cannot do remote push at all — Expo Go, web. */
  readonly isSupported: boolean;
  /**
   * Declared as properties rather than as methods on purpose: none of them
   * reads `this`, and a method-shaped declaration invites a caller to pull one
   * off the object and lose its receiver.
   */
  readonly ensureChannels: () => Promise<void>;
  readonly getPermission: () => Promise<PushPermission>;
  readonly requestPermission: () => Promise<PushPermission>;
  readonly acquireToken: () => Promise<string>;
  readonly describeDevice: () => DeviceDescription;
}

/** What became of an attempt to register. Every branch is a state, not an error. */
export type PushRegistrationOutcome =
  | {
      readonly status: 'registered';
      readonly device: Device;
      /** The token that registration was made with — what a rotation is compared against. */
      readonly expoPushToken: string;
    }
  /** The runtime has no remote push. Nothing was attempted. */
  | { readonly status: 'unsupported' }
  /** Permission was not granted — refused, or not the moment to ask. */
  | { readonly status: 'not-permitted'; readonly permission: PushPermission }
  /** Permitted, but Expo would not mint a token: offline, or no EAS project id. */
  | { readonly status: 'token-unavailable' }
  /** The token exists and our own API refused or never answered. */
  | { readonly status: 'registration-failed' };

export interface RegistrationOptions {
  /**
   * Whether this call site is allowed to show the permission dialog.
   *
   * **This is the whole of the onboarding decision, expressed as one flag.**
   * Launch-time registration passes `false` and therefore registers only a
   * phone that has already agreed; the single call site that earned the
   * question passes `true`.
   */
  readonly mayAsk: boolean;
}

/** Posts a registration to our own API. */
export type RegisterDevice = (registration: DeviceRegistration) => Promise<Device>;

/**
 * Channels, then permission, then a token, then our API — in that order.
 *
 * **The order is a platform requirement, not a preference.** Expo documents
 * that on Android 13 the system permission prompt does not appear until at
 * least one notification channel exists, and that
 * `setNotificationChannelAsync` must run before the token call. A registration
 * that created its channels afterwards would work on every developer's phone
 * and silently never prompt on a current Android.
 *
 * **Nothing here throws.** Every way this can end is a state the caller
 * renders as nothing: a user who refused notifications, a phone with no
 * network, an API that answered 503. The issue's requirement that a failed
 * registration must never block a screen is met by there being no failure to
 * catch.
 */
export async function registerPushDevice(
  platform: PushPlatform,
  register: RegisterDevice,
  { mayAsk }: RegistrationOptions,
): Promise<PushRegistrationOutcome> {
  if (!platform.isSupported) {
    return { status: 'unsupported' };
  }

  await platform.ensureChannels();

  const existing = await platform.getPermission();
  const permission =
    existing === 'askable' && mayAsk ? await platform.requestPermission() : existing;

  if (permission !== 'granted') {
    return { status: 'not-permitted', permission };
  }

  let expoPushToken: string;
  try {
    expoPushToken = await platform.acquireToken();
  } catch {
    // Expo's own guidance for this call is to catch it and try again later —
    // it makes a network request, and a build with no EAS project id refuses
    // outright. The caller retries on the next launch.
    return { status: 'token-unavailable' };
  }

  const { platform: devicePlatform, deviceId, appVersion } = platform.describeDevice();

  try {
    const device = await register({
      expoPushToken,
      platform: devicePlatform,
      // Spread rather than assigned: `POST /devices` validates with
      // `.strict()`, and an explicit `deviceId: undefined` serialises to a
      // key that is absent from the body but present in the object — which is
      // fine over JSON and misleading to read. Omitting says what is meant.
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(appVersion === undefined ? {} : { appVersion }),
    });

    return { status: 'registered', device, expoPushToken };
  } catch {
    return { status: 'registration-failed' };
  }
}
