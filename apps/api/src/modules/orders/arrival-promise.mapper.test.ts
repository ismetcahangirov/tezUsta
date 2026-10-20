import { describe, expect, it } from 'vitest';

import { arrivalOutcome, toArrivalPromise } from './arrival-promise.mapper';

const ACCEPTED = new Date('2026-10-20T09:00:00.000Z');
const PROMISED = new Date('2026-10-20T09:12:30.000Z');

const at = (iso: string) => new Date(iso);

describe('toArrivalPromise (ADR-0055 § 13)', () => {
  it('is null until a promise exists', () => {
    expect(toArrivalPromise({ promisedArrivalAt: null, arrivalPromiseSource: null })).toBeNull();
  });

  it('measures the time left on the server’s clock at the moment of answering', () => {
    expect(
      toArrivalPromise(
        { promisedArrivalAt: PROMISED, arrivalPromiseSource: 'route' },
        at('2026-10-20T09:02:30.000Z'),
      ),
    ).toStrictEqual({ promisedAt: PROMISED.toISOString(), secondsRemaining: 600, source: 'route' });
  });

  it('goes negative once the promise has passed', () => {
    const promise = toArrivalPromise(
      { promisedArrivalAt: PROMISED, arrivalPromiseSource: 'estimate' },
      at('2026-10-20T09:13:00.500Z'),
    );

    expect(promise?.secondsRemaining).toBe(-31);
    expect(promise?.source).toBe('estimate');
  });
});

describe('arrivalOutcome (ADR-0055 § 11)', () => {
  const arrivedAt = (iso: string) => [
    { toStatus: 'ACCEPTED', createdAt: ACCEPTED },
    { toStatus: 'MASTER_ON_THE_WAY', createdAt: at('2026-10-20T09:01:00.000Z') },
    { toStatus: 'MASTER_ARRIVED', createdAt: at(iso) },
  ];

  it.each([
    ['early', '2026-10-20T09:10:00.000Z', -150],
    ['on time', '2026-10-20T09:12:30.000Z', 0],
    ['late', '2026-10-20T09:15:50.000Z', 200],
  ])('measures a %s arrival against the promise', (_label, iso, lateBySeconds) => {
    expect(arrivalOutcome(arrivedAt(iso), ACCEPTED, PROMISED)).toStrictEqual({
      arrivedAt: at(iso),
      lateBySeconds,
    });
  });

  it('is empty until the master arrives', () => {
    expect(
      arrivalOutcome([{ toStatus: 'ACCEPTED', createdAt: ACCEPTED }], ACCEPTED, PROMISED),
    ).toStrictEqual({ arrivedAt: null, lateBySeconds: null });
  });

  it('ignores an earlier master’s arrival before a re-dispatch, using the current accept', () => {
    const reaccepted = at('2026-10-20T10:00:00.000Z');
    const history = [
      ...arrivedAt('2026-10-20T09:15:50.000Z'),
      { toStatus: 'SEARCHING', createdAt: at('2026-10-20T09:20:00.000Z') },
      { toStatus: 'ACCEPTED', createdAt: reaccepted },
    ];

    expect(arrivalOutcome(history, reaccepted, at('2026-10-20T10:10:00.000Z'))).toStrictEqual({
      arrivedAt: null,
      lateBySeconds: null,
    });
    expect(
      arrivalOutcome(
        [...history, { toStatus: 'MASTER_ARRIVED', createdAt: at('2026-10-20T10:09:00.000Z') }],
        reaccepted,
        at('2026-10-20T10:10:00.000Z'),
      ),
    ).toStrictEqual({ arrivedAt: at('2026-10-20T10:09:00.000Z'), lateBySeconds: -60 });
  });

  it('reports an arrival without a lateness when no promise was ever written', () => {
    expect(arrivalOutcome(arrivedAt('2026-10-20T09:15:50.000Z'), ACCEPTED, null)).toStrictEqual({
      arrivedAt: at('2026-10-20T09:15:50.000Z'),
      lateBySeconds: null,
    });
  });

  it('has nothing to say while nobody is assigned', () => {
    expect(arrivalOutcome(arrivedAt('2026-10-20T09:15:50.000Z'), null, null)).toStrictEqual({
      arrivedAt: null,
      lateBySeconds: null,
    });
  });
});
