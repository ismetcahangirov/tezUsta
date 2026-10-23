import { parsePriceInput } from './parse-price-input';

describe('parsePriceInput (ADR-0060)', () => {
  it.each([
    ['45', 4500],
    ['45.5', 4550],
    ['45,50', 4550],
    ['0.10', 10],
    ['  120 ', 12000],
    ['45.1', 4510],
  ])('reads %p as %p qəpik, exactly', (text, minor) => {
    expect(parsePriceInput(text)).toBe(minor);
  });

  it.each(['', '0', '0.00', '-5', '4.555', '4.', '.5', 'abc', '1e3', '12 34', '1000001'])(
    'refuses %p',
    (text) => {
      expect(parsePriceInput(text)).toBeNull();
    },
  );
});
