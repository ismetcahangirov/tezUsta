import { anchorFor, countdownAt } from './arrival-countdown';

describe('the arrival countdown’s arithmetic (ADR-0055 § 12–13)', () => {
  const anchor = anchorFor(600, 1_000);

  it('is pending until there is a promise', () => {
    expect(countdownAt(null, 5_000)).toStrictEqual({ state: 'pending' });
  });

  it('anchors the server’s seconds to the monotonic clock of receipt', () => {
    expect(anchor).toStrictEqual({ deadlineMono: 601_000 });
  });

  it.each([
    [1_000, 10, 600],
    [61_000, 9, 540],
    // 539.5 s left rounds up to 540 s, and 9 minutes.
    [61_500, 9, 540],
    // 60 s exactly is still "1 min".
    [541_000, 1, 60],
  ])('at %i ms reads %i min (%i s) left, rounded up', (now, minutesLeft, secondsLeft) => {
    expect(countdownAt(anchor, now)).toStrictEqual({ state: 'counting', minutesLeft, secondsLeft });
  });

  it('says "under a minute" instead of a zero', () => {
    expect(countdownAt(anchor, 560_000)).toStrictEqual({
      state: 'counting',
      minutesLeft: null,
      secondsLeft: 41,
    });
  });

  it('is late from the moment the promise passes, by whole minutes rounded up', () => {
    expect(countdownAt(anchor, 601_000)).toStrictEqual({ state: 'late', lateByMinutes: 1 });
    expect(countdownAt(anchor, 601_001)).toStrictEqual({ state: 'late', lateByMinutes: 1 });
    expect(countdownAt(anchor, 781_000)).toStrictEqual({ state: 'late', lateByMinutes: 3 });
    expect(countdownAt(anchor, 781_001)).toStrictEqual({ state: 'late', lateByMinutes: 4 });
  });

  it('counts down from a promise that was already late when it arrived', () => {
    expect(countdownAt(anchorFor(-90, 0), 0)).toStrictEqual({ state: 'late', lateByMinutes: 2 });
  });
});
