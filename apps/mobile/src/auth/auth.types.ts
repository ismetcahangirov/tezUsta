/**
 * The wire shape of the EPIC 2 authentication endpoints.
 *
 * Transcribed from `apps/api/src/modules/auth/auth.types.ts` rather than
 * imported: `apps/mobile` may not import `apps/api` (CLAUDE.md §14), and
 * `packages/types` does not exist yet because a shared package is created on
 * its **second** consumer (ADR-0016). When `apps/admin` arrives, this file is
 * the half that moves there.
 */

/**
 * What `POST /auth/otp/verify` and `POST /auth/refresh` both return.
 *
 * The two `*ExpiresAt` fields are `Date` on the server and **strings** here.
 * JSON has no date type, so typing them `Date` would compile and then hand
 * every caller a string at runtime — the kind of mistake that survives a
 * typecheck and fails on a device.
 *
 * Nothing in the app reads the expiry timestamps today: the refresh is driven
 * by the 401 the server actually returns, not by the clock, because a device
 * clock can be wrong by hours and a pre-emptive refresh scheduled from a wrong
 * clock rotates the refresh token for no reason. They are kept in the type
 * because the server sends them and a client that silently drops a field it
 * was given is harder to debug than one that names it.
 */
export interface TokenPairResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  /**
   * `<uuid>.<base64url secret>` — opaque, deliberately not a JWT. The client
   * never inspects it; it goes straight to `expo-secure-store`.
   */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

/** `POST /auth/otp/request` — the body is identical for known and unknown numbers. */
export interface OtpRequest {
  readonly phone: string;
}

/** `POST /auth/otp/verify`. */
export interface OtpVerification {
  readonly phone: string;
  readonly code: string;
}
