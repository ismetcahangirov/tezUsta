import type { UserRoleName, UserStatusName } from '../../infra/database/schema/users';

/**
 * Issuer and audience for the **consumer** token family (customer / master,
 * signed in from `apps/mobile` with a phone number and an OTP).
 *
 * These are not decoration. `docs/architecture/authentication.md` § Admin
 * authentication requires that the consumer path and the admin path (EPIC 13)
 * "share no issuer, no audience claim, and no refresh family, so an admin
 * credential cannot sign in to the mobile app and a phone OTP cannot sign in
 * to the admin panel. That is a structural guarantee, not a check somebody can
 * forget." Verification rejects a token whose `iss`/`aud` are not exactly
 * these, so the day `apps/admin` mints its own tokens the separation already
 * holds without anyone remembering to add a check.
 */
export const CONSUMER_TOKEN_ISSUER = 'tezusta-api';
export const CONSUMER_TOKEN_AUDIENCE = 'tezusta-consumer';

/**
 * The claim set carried by an access token.
 *
 * `roles` is a **cache, not an authority**
 * (`docs/architecture/authentication.md` § Role claims are a cache, not an
 * authority). A token minted before an admin suspended a master still says
 * `master`, so every authorization decision re-reads current status from the
 * database (issue #27). The claim exists so a handler knows what the caller
 * *claims*, not what they may do.
 */
export interface AccessTokenClaims {
  /** The user id (RFC 7519 §4.1.2 `sub`). */
  readonly sub: string;
  /** The device session this token was minted for — the refresh family id. */
  readonly sid: string;
  readonly roles: readonly UserRoleName[];
  readonly iss: typeof CONSUMER_TOKEN_ISSUER;
  readonly aud: typeof CONSUMER_TOKEN_AUDIENCE;
  /** Seconds since the epoch (RFC 7519 §2, NumericDate). */
  readonly iat: number;
  readonly exp: number;
}

/** What a handler actually needs to mint a token; the rest is derived. */
export interface AccessTokenSubject {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly UserRoleName[];
}

/**
 * What sign-in and refresh both return. The two expiry timestamps are sent to
 * the client so it can schedule a refresh instead of discovering expiry as a
 * 401 mid-screen — they are a convenience, never the thing the server trusts.
 */
export interface TokenPair {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  /**
   * `<uuid>.<base64url secret>` — an opaque string, deliberately not a JWT.
   * A refresh token is checked against the database on every use anyway, so a
   * self-contained token would buy nothing and would leak its claims to
   * anyone holding the ciphertext-free payload.
   */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

/**
 * The caller, as resolved from the database on every authenticated request —
 * never assembled from token claims alone.
 */
export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly UserRoleName[];
  readonly status: UserStatusName;
}

/** Device metadata a client may supply. Never trusted for authorization. */
export interface DeviceInfo {
  readonly deviceId?: string | undefined;
  readonly userAgent?: string | undefined;
}
