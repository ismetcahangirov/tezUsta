import type { AppRole, SessionIdentity } from '../store/session-slice';

/**
 * Reading the claims out of an access token, for the **user interface only**.
 *
 * The client cannot verify a signature — it holds no key, and a client that
 * held one would be shipping the server's secret in an APK. So nothing read
 * here is trusted: it decides which tab to show and whether a role switch is
 * offered. Every actual authorisation decision is made by the server, per
 * request, against current database state
 * (docs/architecture/authentication.md § Authorization).
 *
 * The one thing that must hold is **fail-closed**: a token this cannot read
 * yields no identity at all rather than a partially-invented one.
 */

/** The `roles` values `apps/mobile` knows how to render. */
const APP_ROLES: readonly AppRole[] = ['customer', 'master'];

/** RFC 4648 §5 — base64url, the alphabet a JWT segment is encoded in. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const BITS_PER_CHARACTER = 6;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;

/** `header.payload.signature` — three segments, and the middle one is ours. */
const JWT_SEGMENTS = 3;
const PAYLOAD_SEGMENT = 1;

/**
 * Decodes a base64url segment to a string, one byte per code unit.
 *
 * Hand-rolled rather than `atob`: React Native does not install `atob` as a
 * global (it is absent from `react-native/Libraries/Core` and from Expo's
 * winter runtime in SDK 57), so a call to it would typecheck against the DOM
 * lib and then throw on a device.
 *
 * Bytes are mapped straight to code units, which is **Latin-1, not UTF-8**.
 * That is correct for this one payload and no other: the consumer access
 * token's claim set is `sub`, `sid`, `roles`, `iss`, `aud`, `iat`, `exp`
 * (`apps/api/src/modules/auth/auth.types.ts`) — uuids, two fixed role strings,
 * two fixed identifiers, and numbers, all ASCII by construction. If a claim
 * carrying a name or an address is ever added, this must become a real UTF-8
 * decode; until then a `TextDecoder` that jsdom does not always expose would
 * be a test-environment dependency bought for nothing.
 */
function decodeBase64Url(segment: string): string | null {
  let bits = 0;
  let accumulator = 0;
  let decoded = '';

  for (const character of segment) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value === -1) {
      // Padding is legal at the end and carries no bits; anything else means
      // this is not a base64url segment.
      if (character === '=') {
        break;
      }
      return null;
    }

    accumulator = (accumulator << BITS_PER_CHARACTER) | value;
    bits += BITS_PER_CHARACTER;

    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE;
      decoded += String.fromCharCode((accumulator >> bits) & BYTE_MASK);
    }
  }

  return decoded;
}

/** The subset of the claim set this app reads. */
interface AccessTokenClaims {
  readonly sub?: unknown;
  readonly roles?: unknown;
}

function toAppRoles(claim: unknown): AppRole[] {
  if (!Array.isArray(claim)) {
    return [];
  }

  // Matched against a literal allow-list rather than cast: the token also
  // carries roles this app has no screens for, and a future server role must
  // not arrive here as a route group that does not exist.
  return APP_ROLES.filter((role) => claim.includes(role));
}

/**
 * Returns the user id and app-renderable roles a token claims, or `null` if it
 * is not a readable token.
 */
export function readAccessTokenIdentity(accessToken: string): SessionIdentity | null {
  const segments = accessToken.split('.');
  if (segments.length !== JWT_SEGMENTS) {
    return null;
  }

  const payload = decodeBase64Url(segments[PAYLOAD_SEGMENT] ?? '');
  if (payload === null || payload === '') {
    return null;
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(payload) as AccessTokenClaims;
  } catch {
    // Deliberately silent. The token is the one thing that must never reach a
    // log (CLAUDE.md §11), and a parse error whose message quotes the input is
    // exactly how a token reaches one.
    return null;
  }

  if (claims === null || typeof claims !== 'object') {
    return null;
  }

  return {
    userId: typeof claims.sub === 'string' ? claims.sub : null,
    roles: toAppRoles(claims.roles),
  };
}
