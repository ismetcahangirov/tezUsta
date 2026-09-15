/**
 * The `EXPO_PUBLIC_` guard (`CLAUDE.md` §4, `docs/engineering/security.md` §
 * "EXPO_PUBLIC_ and what counts as a secret").
 *
 * Anything prefixed `EXPO_PUBLIC_` ships inside the Expo app bundle and is
 * readable by anyone who unzips the APK. A value is a secret if it grants
 * server authority or billing power — those must never carry that prefix.
 * This is a real, mechanical check over the whole source environment, not a
 * comment: it runs against every key present, independent of which keys the
 * rest of the config schema declares, because a stray `EXPO_PUBLIC_JWT_SECRET`
 * would otherwise pass through unnoticed as an "unknown" variable.
 *
 * Two documented exceptions ship in the bundle deliberately: platform-
 * restricted client map keys, protected by bundle id / package name
 * restriction rather than secrecy (ADR-0004). Everything else matching a
 * secret-ish token is rejected.
 */

const EXPO_PUBLIC_PREFIX = 'EXPO_PUBLIC_';

/**
 * Substrings that mark a variable name as secret-bearing. Matched against the
 * variable name only — never its value, which is never inspected or printed
 * by this guard.
 */
const SECRET_NAME_TOKENS = [
  'SECRET',
  'PRIVATE',
  'PASSWORD',
  'TOKEN',
  'DATABASE_URL',
  'REDIS_URL',
  'GOOGLE_MAPS_SERVER_API_KEY',
] as const;

/**
 * The only documented exceptions: platform-restricted client map keys that
 * the mobile app cannot render a map without, protected by restriction rather
 * than secrecy (ADR-0004, docs/engineering/security.md).
 */
const ALLOWED_EXPO_PUBLIC_SECRET_LIKE_KEYS: ReadonlySet<string> = new Set([
  'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY',
  'EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY',
]);

/**
 * Scans every key of `source` and returns the names — **names only, never
 * values** — of any `EXPO_PUBLIC_`-prefixed variable that looks secret-bearing
 * and is not on the documented exception list.
 */
export function findExpoPublicSecretViolations(
  source: Readonly<Record<string, string | undefined>>,
): string[] {
  const offending: string[] = [];

  for (const key of Object.keys(source)) {
    if (!key.startsWith(EXPO_PUBLIC_PREFIX)) {
      continue;
    }
    if (ALLOWED_EXPO_PUBLIC_SECRET_LIKE_KEYS.has(key)) {
      continue;
    }
    if (SECRET_NAME_TOKENS.some((token) => key.includes(token))) {
      offending.push(key);
    }
  }

  return offending;
}
