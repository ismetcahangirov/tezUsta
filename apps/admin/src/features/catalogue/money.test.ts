import { describe, expect, it } from 'vitest';

import { formatAzn, minorToAznInput, parseAznToMinor } from './money';

describe('parseAznToMinor', () => {
  it.each([
    ['45.50', 4550],
    ['45,5', 4550],
    ['45', 4500],
    ['4.35', 435],
    ['0.01', 1],
    ['100000', 10_000_000],
    ['  19.99 ', 1999],
  ])('reads %j as %i qəpik exactly', (input, minor) => {
    expect(parseAznToMinor(input)).toEqual({ ok: true, minor });
  });

  it.each(['', 'abc', '4.355', '-5', '1e3', '4.', '.5', '1 000'])(
    'refuses %j as not an amount',
    (input) => {
      expect(parseAznToMinor(input)).toEqual({ ok: false, reason: 'format' });
    },
  );

  it.each(['0', '0.00', '100000.01'])('refuses %j as out of range', (input) => {
    expect(parseAznToMinor(input)).toEqual({ ok: false, reason: 'range' });
  });
});

describe('minorToAznInput', () => {
  it('writes qəpik back as the manats an admin would type', () => {
    expect(minorToAznInput(4550)).toBe('45.50');
    expect(minorToAznInput(7)).toBe('0.07');
    expect(minorToAznInput(10_000_000)).toBe('100000.00');
  });

  it('round-trips through the parser', () => {
    for (const minor of [1, 99, 435, 4550, 123_456]) {
      expect(parseAznToMinor(minorToAznInput(minor))).toEqual({ ok: true, minor });
    }
  });
});

describe('formatAzn', () => {
  it('shows the amount in manats with the currency', () => {
    const shown = formatAzn(4550);
    // The exact glyphs are ICU's and differ between platforms; the digits do not.
    expect(shown).toMatch(/45[.,]50/);
    expect(shown).toBe(
      new Intl.NumberFormat('az-AZ', { style: 'currency', currency: 'AZN' }).format(45.5),
    );
  });
});
