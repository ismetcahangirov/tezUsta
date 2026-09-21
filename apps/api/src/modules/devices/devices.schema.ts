import { z } from 'zod';

/**
 * Validation for the device-registry endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest, Fastify or
 * Drizzle type appears below, so the day `apps/mobile` reuses these shapes the
 * move to `packages/validation` is a file move rather than a rewrite.
 */

/** Matches `devices.expo_push_token`'s column cap; the column is the backstop. */
export const MAX_PUSH_TOKEN_LENGTH = 255;
/** Matches `devices.device_id`, which in turn matches `sessions.device_id`. */
export const MAX_DEVICE_ID_LENGTH = 128;
export const MAX_APP_VERSION_LENGTH = 32;

/**
 * The bracketed form Expo mints today, in both its current and legacy
 * prefixes.
 *
 * The inner run is bounded but not otherwise constrained: Expo's own tokens
 * carry 22 URL-safe characters, but nothing published commits to that, and a
 * server that rejected a 24-character token would be rejecting a phone Expo
 * would happily have delivered to.
 */
const BRACKETED_PUSH_TOKEN = /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9._-]{1,200}\]$/;

/**
 * The bare-uuid form.
 *
 * Case-insensitive and version-agnostic, matching the predicate quoted below
 * rather than a stricter reading of RFC 4122.
 */
const UUID_PUSH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this a token Expo's push service would accept?
 *
 * **Three shapes, and the third one surprises people.** Taken from the shipped
 * `expo-server-sdk@7.2.0`, `build/ExpoClient.js` — verified against the
 * package on 2026-09-21, not against the documentation, which shows only
 * `ExponentPushToken[...]`:
 *
 * ```js
 * static isExpoPushToken(token) {
 *   return (typeof token === 'string' &&
 *     (((token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) &&
 *       token.endsWith(']')) ||
 *       /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token)));
 * }
 * ```
 *
 * CLAUDE.md §9 settles the disagreement between the two sources the way it
 * always does: the artifact wins.
 *
 * **Accepting everything the transport accepts is the deliberate choice**, and
 * the asymmetry is why. A token wrongly accepted here is caught downstream —
 * Expo answers with a ticket or a receipt saying the device is not registered,
 * and issue #142 retires the row. A token wrongly *rejected* here produces a
 * phone that is simply never reachable, with the failure landing at
 * registration where nobody is looking. One is recoverable; the other is
 * silent.
 *
 * This regex is deliberately *narrower than the SDK's prefix check* in one
 * respect — the SDK accepts `ExponentPushToken[]` with nothing inside, and a
 * token with no body cannot address anything. Every shape the SDK accepts and
 * this rejects must be one that could not have been delivered to.
 *
 * Issue #141 adds `expo-server-sdk` as a real dependency; when it does, it
 * should pin this predicate against `Expo.isExpoPushToken` directly, so a
 * future SDK that loosens the rule is noticed here rather than in production.
 */
function isExpoPushToken(value: string): boolean {
  return BRACKETED_PUSH_TOKEN.test(value) || UUID_PUSH_TOKEN.test(value);
}

const expoPushToken = z
  .string()
  .max(MAX_PUSH_TOKEN_LENGTH)
  .refine(isExpoPushToken, { message: 'Not an Expo push token.' });

/**
 * Recorded rather than inferred: the token does not say which platform it came
 * from, and a delivery problem that turns out to be one platform's credentials
 * is the first question anybody asks.
 */
const platform = z.enum(['ios', 'android']);

/**
 * `.strict()` so an unknown key is a 422 rather than a silently dropped field.
 *
 * It also closes a specific hole: a client that sent `userId` alongside its
 * token would look like it was choosing an owner. It never is — the owner is
 * the authenticated actor — and the loudest way to say so is to refuse the
 * request.
 */
export const registerDeviceSchema = z
  .object({
    expoPushToken,
    platform,
    deviceId: z.string().trim().min(1).max(MAX_DEVICE_ID_LENGTH).optional(),
    appVersion: z.string().trim().min(1).max(MAX_APP_VERSION_LENGTH).optional(),
  })
  .strict();

export const deviceIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type RegisterDeviceRequest = z.infer<typeof registerDeviceSchema>;

/**
 * How much of a push token the API is willing to show.
 *
 * Short enough to be useless as an address — the bracketed form carries at
 * least twenty characters of entropy and this reveals five of them — and long
 * enough that one person can tell their two phones apart in a list.
 */
export const TOKEN_SUFFIX_LENGTH = 6;
