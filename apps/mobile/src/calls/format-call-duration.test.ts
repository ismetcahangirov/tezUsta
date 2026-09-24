import { formatCallDuration } from './format-call-duration';

describe('formatCallDuration', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [1_000, '0:01'],
    [7_400, '0:07'],
    [59_999, '0:59'],
    [60_000, '1:00'],
    [65_000, '1:05'],
    [750_000, '12:30'],
    [4_502_000, '75:02'],
  ])('%i ms reads as %s', (ms, expected) => {
    expect(formatCallDuration(ms)).toBe(expected);
  });

  it('reads a clock that stepped backwards as zero, not as a negative time', () => {
    expect(formatCallDuration(-3_000)).toBe('0:00');
  });
});
