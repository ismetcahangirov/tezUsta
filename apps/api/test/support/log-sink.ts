import type { MockInstance } from 'vitest';
import { vi } from 'vitest';

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
