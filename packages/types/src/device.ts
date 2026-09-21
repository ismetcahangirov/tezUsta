/**
 * Which push transport a device is reachable over.
 *
 * `web` is absent because `apps/mobile` is the only client. A value nothing
 * can produce is one every consumer still has to handle.
 */
export type DevicePlatform = 'ios' | 'android';

/**
 * A push-addressable installation of the app, as the API returns it.
 *
 * **The push token is deliberately not here.** It is the address Expo
 * delivers to, so anyone holding it can push to that phone, and CLAUDE.md §11
 * treats it the way it treats every other token: never logged, never echoed.
 * What the API returns instead is {@link tokenSuffix} — enough for a person
 * to tell two of their own phones apart in a list, and not enough to address
 * either of them.
 *
 * `userId` is absent for the reason it is absent from `Customer`: nothing a
 * client does needs it. A device is always the caller's own, checked
 * server-side against the actor on every request.
 *
 * A retired device is simply not returned, so there is no `revokedAt` here.
 * The row keeps that — "why did my old phone stop receiving?" is a support
 * question with a recorded answer — but it is not a state a client renders.
 */
export interface Device {
  readonly id: string;
  readonly platform: DevicePlatform;
  /**
   * The last few characters of the push token, and nothing more.
   *
   * Short enough to be useless as an address and long enough to distinguish
   * the two phones one person is likely to have registered.
   */
  readonly tokenSuffix: string;
  /**
   * A name the client chose for itself, or `null` when it sent none.
   *
   * Client-supplied and therefore **never trusted for authorization** — it
   * exists so a device list reads "Pixel 7" rather than an opaque uuid.
   */
  readonly deviceId: string | null;
  /** The app version that last registered this device, or `null`. */
  readonly appVersion: string | null;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  /** ISO 8601, UTC. */
  readonly updatedAt: string;
  /**
   * When the client last re-registered — the only evidence the server gets
   * that an installation is still alive. ISO 8601, UTC.
   */
  readonly lastSeenAt: string;
}

/**
 * What a client sends to register or refresh its device.
 *
 * Registration is idempotent on the token: sending the same one twice leaves
 * one device, and sending a token that already belongs to somebody else moves
 * it to the caller rather than duplicating it. Both are properties of the
 * unique constraint on the column, not of this shape — see
 * `apps/api/src/infra/database/schema/devices.ts`.
 */
export interface DeviceRegistration {
  readonly expoPushToken: string;
  readonly platform: DevicePlatform;
  readonly deviceId?: string | undefined;
  readonly appVersion?: string | undefined;
}
