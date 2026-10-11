import type { SubscriptionBillingPeriod } from '@tezusta/types';

/**
 * Subscription period arithmetic (ADR-0046 § 5, issue #322).
 *
 * A period is one **calendar** month or one calendar year as a master in Baku
 * reads a calendar, not a fixed number of days: a master who pays on the 5th
 * expects to renew on the 5th. A day that the target month does not have is
 * clamped to its last day, so 31 January plus one month is 28 or 29 February
 * and 29 February plus one year is 28 February.
 *
 * Computed through `Intl`'s copy of the tz database rather than a hard-coded
 * `+04:00`. Azerbaijan has had no daylight saving since 2016, so the two agree
 * today; the tz database is what keeps this right if that ever changes, and it
 * costs no dependency.
 *
 * Each period is measured from its own start, so a period that was clamped
 * stays on the clamped day: 31 January, 28 February, 28 March. There is no
 * stored billing anchor to return to.
 */

export const SUBSCRIPTION_TIME_ZONE = 'Asia/Baku';

const MONTHS_IN: Readonly<Record<SubscriptionBillingPeriod, number>> = Object.freeze({
  monthly: 1,
  yearly: 12,
});

/** A Baku wall-clock reading. `month` is 1–12. */
interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const bakuFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SUBSCRIPTION_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function toWallClock(instant: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const part of bakuFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year ?? Number.NaN,
    month: parts.month ?? Number.NaN,
    day: parts.day ?? Number.NaN,
    hour: parts.hour ?? Number.NaN,
    minute: parts.minute ?? Number.NaN,
    second: parts.second ?? Number.NaN,
    millisecond: instant.getUTCMilliseconds(),
  };
}

/** The wall clock's fields read as if they were UTC — the arithmetic base for both directions. */
function wallAsUtcMs(wall: WallClock): number {
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
}

/** How far Baku's clock is ahead of UTC at this instant, in milliseconds. */
function offsetMsAt(instant: Date): number {
  return wallAsUtcMs(toWallClock(instant)) - instant.getTime();
}

/**
 * The instant at which Baku's clock reads `wall`.
 *
 * Two passes, the standard way: guess with the offset at the naive instant,
 * then correct with the offset at the guess. With no DST in effect the first
 * pass is already exact.
 */
function fromWallClock(wall: WallClock): Date {
  const naive = wallAsUtcMs(wall);
  const guess = naive - offsetMsAt(new Date(naive));
  return new Date(naive - offsetMsAt(new Date(guess)));
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function assertValidInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('A subscription period cannot start at an invalid date.');
  }
}

/** `instant` plus `months` calendar months on Baku's calendar, clamped to the month's last day. */
export function addCalendarMonths(instant: Date, months: number): Date {
  assertValidInstant(instant);
  if (!Number.isInteger(months) || months < 0) {
    throw new RangeError(`Months must be a non-negative integer, got ${String(months)}.`);
  }

  const wall = toWallClock(instant);
  const monthIndex = wall.year * 12 + (wall.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const day = Math.min(wall.day, daysInMonth(year, month));

  return fromWallClock({ ...wall, year, month, day });
}

/** The end of a period of `billingPeriod` that starts at `start`. */
export function addBillingPeriod(start: Date, billingPeriod: SubscriptionBillingPeriod): Date {
  return addCalendarMonths(start, MONTHS_IN[billingPeriod]);
}

/**
 * `instant` plus `days` calendar days on Baku's calendar — the trial, the
 * grace and an admin grant are lengths in days.
 */
export function addCalendarDays(instant: Date, days: number): Date {
  assertValidInstant(instant);
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`Days must be a non-negative integer, got ${String(days)}.`);
  }

  const wall = toWallClock(instant);
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));

  return fromWallClock({
    ...wall,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}
