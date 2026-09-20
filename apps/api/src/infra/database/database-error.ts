/**
 * What a failed database call actually looks like by the time it reaches us,
 * and how much of it may be written down.
 *
 * `drizzle-orm@0.45.2` wraps **every** statement error before rethrowing it
 * (`pg-core/session.js` → `new DrizzleQueryError(queryString, params, e)`),
 * and that wrapper's message is built as:
 *
 * ```js
 * super(`Failed query: ${query}\nparams: ${params}`);
 * ```
 *
 * Two consequences, one per issue this module exists for:
 *
 * - The message — and therefore `stack`, which begins with it — interpolates
 *   every bound parameter. On the authentication path those are phone
 *   numbers, which CLAUDE.md §11 forbids logging (issue #63).
 * - The driver's SQLSTATE is no longer on the thrown error. It is on
 *   `cause`, so a `catch` that matched `error.code === '23505'` on the
 *   throwable itself stopped matching the day the wrapper appeared, and the
 *   retry it guarded silently stopped running (issue #70).
 *
 * Both are read here, once, rather than rediscovered at each call site.
 */

/**
 * PostgreSQL `unique_violation`.
 *
 * @see https://www.postgresql.org/docs/17/errcodes-appendix.html
 */
export const UNIQUE_VIOLATION = '23505';

/**
 * How far down a `cause` chain to look. Drizzle nests exactly one level
 * today; the bound is here so a future wrapper cannot turn a malformed,
 * self-referential chain into a hang.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Fields of `pg`'s `DatabaseError` that cannot contain a value from the failing
 * row or from a bound parameter.
 *
 * Everything omitted is omitted on purpose, and the omissions are the point:
 *
 * - `detail` reads `Key (phone_e164)=(+994...) already exists.` on a unique
 *   violation — the bound value, verbatim.
 * - `message` echoes the offending literal on a cast failure
 *   (`invalid input syntax for type uuid: "..."`).
 * - `hint`, `where` and `internalQuery` can each quote statement text or row
 *   values depending on the error.
 *
 * What remains still names the failing statement precisely — which constraint,
 * which table, which column, which backend routine raised it.
 */
const SAFE_DRIVER_FIELDS = [
  'code',
  'severity',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'routine',
] as const;

function causeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

/** The error itself, then each `cause` under it, innermost last. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;

  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) {
      break;
    }
    chain.push(current);
    current = causeOf(current);
  }

  return chain;
}

function ownString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null || !(key in source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The SQLSTATE the server raised, from anywhere in the chain.
 *
 * Matched on the string rather than on `instanceof DatabaseError`: the
 * five-character SQLSTATE is a PostgreSQL guarantee, the class is a `pg`
 * implementation detail, and keeping the driver's class out of this module
 * keeps it out of every module that imports it.
 */
export function databaseErrorCode(error: unknown): string | undefined {
  for (const link of errorChain(error)) {
    const code = ownString(link, 'code');
    // SQLSTATE is exactly five characters. Node's own `code` properties
    // (`ECONNREFUSED`, `ERR_MODULE_NOT_FOUND`) are not, so the length check is
    // what stops a socket failure being reported as a database one.
    if (code !== undefined && code.length === 5) {
      return code;
    }
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return databaseErrorCode(error) === UNIQUE_VIOLATION;
}

/**
 * The name of the constraint the server named, from anywhere in the chain.
 *
 * `constraint` is already on {@link SAFE_DRIVER_FIELDS} — it names the index
 * or constraint and never quotes a value from the failing row, which is what
 * makes it safe to read and to log.
 */
export function databaseErrorConstraint(error: unknown): string | undefined {
  for (const link of errorChain(error)) {
    const constraint = ownString(link, 'constraint');
    if (constraint !== undefined) {
      return constraint;
    }
  }
  return undefined;
}

/**
 * A unique violation **on one named index**, rather than any unique violation
 * at all.
 *
 * The difference matters wherever a `catch` translates a constraint into a
 * product sentence. A transaction that writes several tables can violate more
 * than one unique index, and `isUniqueViolation` alone would report whichever
 * one fired as the single outcome its author had in mind — a claim that is
 * argued in a comment rather than checked. Naming the index makes the claim
 * checkable by the code: anything else falls through and surfaces as the
 * unhandled error it is, instead of being quietly relabelled.
 *
 * The name is a PostgreSQL identifier, so it is compared exactly; a renamed
 * index stops matching, which is the loud failure rather than the silent one.
 */
export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  return isUniqueViolation(error) && databaseErrorConstraint(error) === constraint;
}

/**
 * The parameterised SQL Drizzle tried to run, if this chain carries it.
 *
 * Matched structurally on the presence of both `query` and `params` rather
 * than with `instanceof DrizzleQueryError`: that class is exported from
 * `drizzle-orm/errors`, which is not part of the package's documented public
 * surface, and an `instanceof` against a deep import is a silent no-op the
 * day the internal path moves or a second copy of the package is installed.
 * A structural match cannot break that way.
 */
function failedStatement(error: unknown): string | undefined {
  for (const link of errorChain(error)) {
    const query = ownString(link, 'query');
    if (query !== undefined && typeof link === 'object' && link !== null && 'params' in link) {
      return query;
    }
  }
  return undefined;
}

/**
 * The stack frames, without the `Error: <message>` header they start with.
 *
 * `stack` is the reason a message that must not be logged cannot simply be
 * left unread: V8 builds the string as the message followed by the frames, so
 * logging `stack` logs the message too. The frames are what an on-call
 * engineer actually needs — they name the call site — and they contain no
 * data.
 */
function stackFrames(error: unknown): string | undefined {
  const stack = ownString(error, 'stack');
  if (stack === undefined) {
    return undefined;
  }
  const firstFrame = stack.search(/^\s+at /mu);
  return firstFrame === -1 ? undefined : stack.slice(firstFrame);
}

/**
 * A log-safe description of a database failure, or `null` when the error is
 * not one.
 *
 * Returning `null` rather than a fallback description is deliberate: the
 * caller keeps its existing behaviour for every other error type, so nothing
 * that is not a database error loses any detail to this module.
 *
 * The SQL text is included and the parameters are not, which is the whole
 * shape of the answer: `insert into "users" ("phone_e164") values ($1)` says
 * which statement failed without saying whose number it failed on. Drizzle
 * always binds values as parameters rather than interpolating them, so the
 * text it hands over carries placeholders only.
 */
export function describeDatabaseFailure(error: unknown): string | null {
  const code = databaseErrorCode(error);
  const statement = failedStatement(error);

  if (code === undefined && statement === undefined) {
    return null;
  }

  const driver = errorChain(error).find((link) => ownString(link, 'code')?.length === 5);

  const fields = SAFE_DRIVER_FIELDS.flatMap((field) => {
    const value = ownString(driver, field);
    return value === undefined ? [] : [`${field}=${value}`];
  });

  const parts = [`DatabaseError ${fields.join(' ')}`.trim()];
  if (statement !== undefined) {
    parts.push(`sql: ${statement}`);
  }

  const frames = stackFrames(error);
  if (frames !== undefined) {
    parts.push(frames);
  }

  return parts.join('\n');
}
