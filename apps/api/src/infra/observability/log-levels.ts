import { ConsoleLogger } from '@nestjs/common';
import type { LogLevel } from '@nestjs/common';

import type { AppLogLevel } from '../config/app-config.types';

/**
 * A `LOG_LEVEL` threshold expanded into the set Nest actually wants.
 *
 * {@link AppLogLevel} is a **threshold**, the way every other logging
 * configuration an operator has ever met is a threshold. Nest's own
 * `LogLevel` is `verbose | debug | log | warn | error | fatal` and its
 * `logger` option takes the *set* of enabled levels rather than a floor, so
 * `['error']` means "only error" and silently drops `fatal` with it. Asking
 * an operator to write that set out is asking them to get it wrong on the day
 * they are trying to quiet a log during an incident.
 *
 * Three things here are deliberate, and each is a criterion of issue #129:
 *
 * - **`fatal` is in every set.** A threshold names the least severe line
 *   worth writing; there is nothing more severe than `fatal`, so no threshold
 *   can mean "hide it".
 * - **`warn` survives every threshold but `error`.** Expected client errors
 *   and rate-limit triggers are logged at `warn` (issue #56,
 *   `common/guards/rate-limit.guard.ts`), and
 *   `docs/engineering/security.md` § Logging requires those triggers to stay
 *   logged. `error` is the one threshold that drops them, which is why
 *   `env.schema.ts` refuses it under `NODE_ENV=production` rather than
 *   letting a mapping quietly break a security requirement.
 * - **`debug` includes `verbose`.** Nothing in `apps/api/src` logs at
 *   `verbose` today, but the lowest threshold has to mean "everything" or a
 *   developer who asked for the most detail available would be the one person
 *   who stopped seeing a line. Today's build passes no `logger` option at all
 *   and therefore prints all six levels; `debug` is what keeps that true.
 */
export function logLevelsFor(threshold: AppLogLevel): LogLevel[] {
  switch (threshold) {
    case 'debug':
      return ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
    case 'info':
      return ['log', 'warn', 'error', 'fatal'];
    case 'warn':
      return ['warn', 'error', 'fatal'];
    case 'error':
      return ['error', 'fatal'];
  }
}

/**
 * The logger the process runs with, built from `LOG_LEVEL`.
 *
 * A `ConsoleLogger` rather than the bare `LogLevel[]` the application option
 * also accepts, so that the object under test and the object that ships are
 * the same one: `log-levels.test.ts` constructs this and asserts against a
 * real sink, which a plain array could not be made to do.
 *
 * No formatting decision is made here. Structured JSON logging is EPIC 17
 * (`docs/architecture/system-design.md` § Observability) and
 * `ConsoleLoggerOptions.json` is where it will go; this function exists to
 * make the level knob real, and doing both at once would have made neither
 * reviewable.
 */
export function createAppLogger(threshold: AppLogLevel): ConsoleLogger {
  return new ConsoleLogger({ logLevels: logLevelsFor(threshold) });
}
