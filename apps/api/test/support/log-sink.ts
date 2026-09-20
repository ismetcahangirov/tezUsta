import { Logger } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import { expect, vi } from 'vitest';

/**
 * Captures everything the process writes to a log sink, so a test can assert on
 * what was — and was not — logged.
 *
 * Covers every place Nest's own `ConsoleLogger` (`@nestjs/common`) actually
 * writes, per the shipped source (`console-logger.service.js`): `console.log`,
 * `console.error`, and — for a printed stack trace — `process.stderr.write`
 * directly, bypassing `console.error` entirely. `console.warn`/`debug`/`info`
 * are included too, since a call site could reasonably use any of them, and
 * these suites exist to keep the promise in general, not just for today's call
 * sites.
 *
 * Shared by `auth.token-logging.test.ts` ("no token value ever appears in
 * logs", issue #25) and `auth.guards.e2e.test.ts` ("the rejection reason
 * appears in the log and never in the response", issue #27). Both depend on the
 * list above being exhaustive, and a copy in each file would mean the day
 * someone discovered a sink it missed, only one of them learned about it.
 *
 * Every test using this must restore the spies afterwards and should assert a
 * positive control first — a suite that passes only because nothing was
 * captured is asserting nothing.
 */
export function spyOnEveryLogSink(sink: string[]): MockInstance[] {
  const record = (...parts: unknown[]): void => {
    sink.push(parts.map((part) => String(part)).join(' '));
  };

  return [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      record(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      record(chunk);
      return true;
    }),
  ];
}

/**
 * The line {@link expectLoggerIsListening} writes. Distinctive enough that
 * nothing else in a sink can be mistaken for it.
 */
export const LOG_CANARY = 'tezusta-log-canary-should-be-captured';

/**
 * The positive control every suite that asserts a log is *empty of something*
 * has to have (issue #127).
 *
 * **A negative log assertion passes when the logger captured nothing at all,
 * and nothing distinguishes the two.** That is not hypothetical:
 * `Test.createTestingModule` installs Nest's `TestingLogger`, whose `log`,
 * `warn`, `debug` and `verbose` are empty bodies, so a suite that forgets
 * `.setLogger(new ConsoleLogger())` asserts against a logger that discards
 * three of the four levels its claim covers — and passes exactly as it would
 * if the code logged every coordinate it ever saw. `master-location.e2e` was
 * in that state until issue #56 moved expected client errors to `warn` and
 * broke its unrelated positive control, which is the only reason anyone
 * found out.
 *
 * **The canary is written at `log`, deliberately.** It is the level
 * `TestingLogger` throws away and `error` is the one it keeps, so a control
 * written at `error` would stay green in precisely the configuration it
 * exists to detect — which is the shape `database-error-logging.test.ts`
 * carried before #127.
 *
 * A canary is the *floor*, not the ceiling. Where the code under test emits a
 * line of its own, assert that line as well: it proves the sink is listening
 * **and** that the production path still writes what the negative assertion
 * assumes it writes.
 *
 * Call it after `spyOnEveryLogSink`, and before the assertions it guards.
 */
export function expectLoggerIsListening(sink: string[], context: string): void {
  new Logger(context).log(LOG_CANARY);

  expect(
    sink.some((entry) => entry.includes(LOG_CANARY)),
    'the log sink captured nothing — every "not logged" assertion after this would pass vacuously',
  ).toBe(true);

  // Removed so the canary cannot satisfy a later assertion about what the
  // code under test wrote, and so a suite asserting an empty sink can still
  // use this.
  const index = sink.findIndex((entry) => entry.includes(LOG_CANARY));
  sink.splice(index, 1);
}
