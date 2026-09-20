import { describe, expect, it } from 'vitest';

import { parseDispatchMetricsArgs } from './dispatch-metrics.cli';

/**
 * The measurement CLI's argument rules (issue #114).
 *
 * The thing worth protecting here is that an operator cannot ask for a window
 * that silently measures the wrong thing — a reversed range, or a `--days`
 * quietly ignored because `--from` was also passed. A report whose window is
 * not what its reader thinks it is produces numbers that go into an ADR as
 * measured; it is the same failure as tuning against fixtures, arrived at by
 * typing.
 */

const NOW = new Date('2026-11-10T12:00:00.000Z');

describe('parseDispatchMetricsArgs', () => {
  it('measures the last thirty days when asked for nothing', () => {
    const { window, json } = parseDispatchMetricsArgs([], NOW);

    expect(window.to).toEqual(NOW);
    expect(window.from).toEqual(new Date('2026-10-11T12:00:00.000Z'));
    expect(json).toBe(false);
  });

  it('counts --days back from now', () => {
    const { window } = parseDispatchMetricsArgs(['--days', '7'], NOW);

    expect(window.from).toEqual(new Date('2026-11-03T12:00:00.000Z'));
    expect(window.to).toEqual(NOW);
  });

  it('takes an explicit range', () => {
    const { window } = parseDispatchMetricsArgs(
      ['--from', '2026-10-01', '--to', '2026-10-08'],
      NOW,
    );

    expect(window.from).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(window.to).toEqual(new Date('2026-10-08T00:00:00.000Z'));
  });

  it('ends a --from-only range at now', () => {
    const { window } = parseDispatchMetricsArgs(['--from', '2026-11-01'], NOW);

    expect(window.to).toEqual(NOW);
  });

  it('refuses --days alongside an explicit bound rather than silently picking one', () => {
    expect(() => parseDispatchMetricsArgs(['--days', '7', '--to', '2026-11-01'], NOW)).toThrow(
      /cannot be combined/,
    );
  });

  it('refuses a window that runs backwards', () => {
    expect(() =>
      parseDispatchMetricsArgs(['--from', '2026-11-08', '--to', '2026-11-01'], NOW),
    ).toThrow(/empty/);
  });

  it('refuses a window of no width', () => {
    expect(() =>
      parseDispatchMetricsArgs(['--from', '2026-11-01', '--to', '2026-11-01'], NOW),
    ).toThrow(/empty/);
  });

  it.each([
    [['--days', '0'], /positive whole number/],
    [['--days', '-3'], /positive whole number/],
    [['--days', '1.5'], /positive whole number/],
    [['--days'], /positive whole number/],
    [['--from', 'last tuesday'], /not a date/],
    [['--from'], /needs a value/],
    [['--weeks', '2'], /Unknown argument/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseDispatchMetricsArgs(argv, NOW)).toThrow(message);
  });

  it('switches to JSON on request', () => {
    expect(parseDispatchMetricsArgs(['--json'], NOW).json).toBe(true);
  });
});
