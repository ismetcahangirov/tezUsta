/**
 * Millisecond value of each suffix accepted by `DURATION_PATTERN` in
 * `infra/config/env.schema.ts`. The two must stay in step: the schema decides
 * which strings are valid configuration, this table decides what they mean.
 */
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type Unit = keyof typeof UNIT_MS;

const DURATION = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Thrown for a string the duration grammar does not accept. Deliberately not
 * an `AppError`: a bad duration is a configuration fault that must stop the
 * process at startup, never a response to a client.
 */
export class InvalidDurationError extends Error {
  constructor(value: string) {
    super(`Invalid duration "${value}" — expected a form such as "15m", "30d" or "3600s".`);
    this.name = 'InvalidDurationError';
    Object.setPrototypeOf(this, InvalidDurationError.prototype);
  }
}

/**
 * Parses the `ms`-style shorthand the JWT TTL variables use (`15m`, `30d`,
 * `3600s`) into milliseconds.
 *
 * Written here instead of adding the `ms` package: the grammar is already
 * pinned by the Zod schema that validates those variables, so this parser only
 * has to agree with a regular expression this repository owns. `ms` accepts a
 * far larger and looser grammar ("2 days", "-1h", floats), none of which the
 * configuration may contain, and accepting it here would silently widen what
 * counts as a valid TTL.
 */
export function parseDurationMs(value: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new InvalidDurationError(value);
  }

  const [, amount, unit] = match;
  if (amount === undefined || unit === undefined) {
    throw new InvalidDurationError(value);
  }

  return Number(amount) * UNIT_MS[unit as Unit];
}

/**
 * The same value in whole seconds, which is the unit JWT `exp`/`iat` claims
 * are defined in (RFC 7519 §2 — a NumericDate is seconds since the epoch).
 */
export function parseDurationSeconds(value: string): number {
  return Math.floor(parseDurationMs(value) / 1000);
}
