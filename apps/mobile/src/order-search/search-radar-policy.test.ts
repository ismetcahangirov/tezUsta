import type { OrderSearchProgress } from '@tezusta/types';

import { deriveRadarView, radarFailureOf, radarIsSearchingVisibly } from './search-radar-policy';

const PROGRESS: OrderSearchProgress = {
  round: 2,
  radiusM: 4_400,
  maxRadiusM: 10_000,
  endsAt: '2026-10-20T10:03:00.000Z',
  offeredCount: 3,
  cells: [],
};

describe('deriveRadarView (ADR-0055 § 1–6)', () => {
  it.each(['DRAFT', 'ACCEPTED', 'MASTER_ON_THE_WAY', 'NO_MASTER_FOUND', 'CANCELLED'] as const)(
    'hides the radar while the order is %s',
    (status) => {
      expect(
        deriveRadarView({ status, progress: PROGRESS, failure: null, connection: 'live' }),
      ).toStrictEqual({ kind: 'hidden' });
    },
  );

  it('hides it when the server says the order stopped searching (409), without an error', () => {
    expect(
      deriveRadarView({
        status: 'SEARCHING',
        progress: null,
        failure: 'not-searching',
        connection: 'live',
      }),
    ).toStrictEqual({ kind: 'hidden' });
  });

  it('is loading until the first read, live after it', () => {
    const base = { status: 'SEARCHING', failure: null, connection: 'live' } as const;

    expect(deriveRadarView({ ...base, progress: null })).toStrictEqual({ kind: 'loading' });
    expect(deriveRadarView({ ...base, progress: PROGRESS })).toStrictEqual({
      kind: 'live',
      progress: PROGRESS,
    });
  });

  it('keeps the last read while reconnecting', () => {
    expect(
      deriveRadarView({
        status: 'SEARCHING',
        progress: PROGRESS,
        failure: null,
        connection: 'reconnecting',
      }),
    ).toStrictEqual({ kind: 'reconnecting', progress: PROGRESS });
  });

  it('reports a failed read only when there is nothing to show', () => {
    const failed = { status: 'SEARCHING', failure: 'other', connection: 'live' } as const;

    expect(deriveRadarView({ ...failed, progress: null })).toStrictEqual({ kind: 'error' });
    expect(deriveRadarView({ ...failed, progress: PROGRESS }).kind).toBe('live');
  });

  it('pulses only while visibly searching', () => {
    expect(radarIsSearchingVisibly({ kind: 'loading' })).toBe(true);
    expect(radarIsSearchingVisibly({ kind: 'live', progress: PROGRESS })).toBe(true);
    expect(radarIsSearchingVisibly({ kind: 'reconnecting', progress: PROGRESS })).toBe(false);
    expect(radarIsSearchingVisibly({ kind: 'error' })).toBe(false);
  });
});

describe('radarFailureOf', () => {
  it('reads 409 as "moved on" and anything else as a failure', () => {
    expect(radarFailureOf(undefined)).toBeNull();
    expect(radarFailureOf({ status: 409, data: { error: { code: 'ORDER_NOT_SEARCHING' } } })).toBe(
      'not-searching',
    );
    expect(radarFailureOf({ status: 500 })).toBe('other');
    expect(radarFailureOf({ status: 'FETCH_ERROR', error: 'offline' })).toBe('other');
  });
});
