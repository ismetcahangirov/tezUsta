import { describe, expect, it } from 'vitest';

import { addBillingPeriod, addCalendarDays, addCalendarMonths } from './subscription-period';

/** An instant written as Baku reads it. Baku is UTC+4 with no DST. */
function baku(local: string): Date {
  return new Date(`${local}+04:00`);
}

describe('subscription period arithmetic (ADR-0046 § 5)', () => {
  describe('a monthly period', () => {
    it('ends on the same day and time next month', () => {
      expect(addBillingPeriod(baku('2027-03-05T10:30:00'), 'monthly')).toEqual(
        baku('2027-04-05T10:30:00'),
      );
    });

    it('clamps 31 January to 28 February in a common year', () => {
      expect(addBillingPeriod(baku('2027-01-31T10:00:00'), 'monthly')).toEqual(
        baku('2027-02-28T10:00:00'),
      );
    });

    it('clamps 31 January to 29 February in a leap year', () => {
      expect(addBillingPeriod(baku('2028-01-31T10:00:00'), 'monthly')).toEqual(
        baku('2028-02-29T10:00:00'),
      );
    });

    it('clamps 31 March to 30 April', () => {
      expect(addBillingPeriod(baku('2027-03-31T23:59:59'), 'monthly')).toEqual(
        baku('2027-04-30T23:59:59'),
      );
    });

    it('crosses the year from 31 December to 31 January', () => {
      expect(addBillingPeriod(baku('2026-12-31T08:00:00'), 'monthly')).toEqual(
        baku('2027-01-31T08:00:00'),
      );
    });

    it('stays on the clamped day afterwards, measured from its own start', () => {
      const february = addBillingPeriod(baku('2027-01-31T10:00:00'), 'monthly');
      expect(addBillingPeriod(february, 'monthly')).toEqual(baku('2027-03-28T10:00:00'));
    });

    it('reads the calendar in Baku, not in UTC', () => {
      // 22:00 UTC on 30 January is already 02:00 on 31 January in Baku. In
      // UTC this would be "30 January plus a month"; in Baku it is the 31st,
      // clamped to 28 February.
      const start = new Date('2027-01-30T22:00:00Z');
      expect(addBillingPeriod(start, 'monthly')).toEqual(baku('2027-02-28T02:00:00'));
      expect(addBillingPeriod(start, 'monthly')).toEqual(new Date('2027-02-27T22:00:00Z'));
    });

    it('keeps milliseconds', () => {
      expect(addBillingPeriod(baku('2027-05-10T12:00:00.123'), 'monthly')).toEqual(
        baku('2027-06-10T12:00:00.123'),
      );
    });
  });

  describe('a yearly period', () => {
    it('ends on the same day next year', () => {
      expect(addBillingPeriod(baku('2027-06-15T09:00:00'), 'yearly')).toEqual(
        baku('2028-06-15T09:00:00'),
      );
    });

    it('clamps 29 February to 28 February the next year', () => {
      expect(addBillingPeriod(baku('2028-02-29T09:00:00'), 'yearly')).toEqual(
        baku('2029-02-28T09:00:00'),
      );
    });

    it('runs from 31 December to 31 December', () => {
      expect(addBillingPeriod(baku('2026-12-31T23:30:00'), 'yearly')).toEqual(
        baku('2027-12-31T23:30:00'),
      );
    });
  });

  describe('the Baku offset', () => {
    it('is a constant four hours, so a day is always 24 hours', () => {
      const start = baku('2027-03-27T12:00:00');
      // The last Sunday of March — the date Azerbaijan used to move its clocks
      // until 2016. It must not move them now.
      expect(addCalendarDays(start, 1).getTime() - start.getTime()).toBe(86_400_000);
      expect(addCalendarDays(baku('2027-10-30T12:00:00'), 1).getTime()).toBe(
        baku('2027-10-31T12:00:00').getTime(),
      );
    });
  });

  describe('a length in days', () => {
    it('adds calendar days across a month end', () => {
      expect(addCalendarDays(baku('2027-02-20T06:00:00'), 14)).toEqual(baku('2027-03-06T06:00:00'));
    });

    it('adds nothing for zero days — a trial of 0 ends as it starts', () => {
      const start = baku('2027-02-20T06:00:00');
      expect(addCalendarDays(start, 0)).toEqual(start);
    });

    it('crosses a leap day', () => {
      expect(addCalendarDays(baku('2028-02-28T10:00:00'), 2)).toEqual(baku('2028-03-01T10:00:00'));
    });
  });

  describe('bad input', () => {
    it('refuses an invalid date', () => {
      expect(() => addBillingPeriod(new Date(Number.NaN), 'monthly')).toThrow(RangeError);
    });

    it('refuses a negative or fractional length', () => {
      expect(() => addCalendarDays(new Date(), -1)).toThrow(RangeError);
      expect(() => addCalendarDays(new Date(), 1.5)).toThrow(RangeError);
      expect(() => addCalendarMonths(new Date(), -1)).toThrow(RangeError);
    });
  });
});
