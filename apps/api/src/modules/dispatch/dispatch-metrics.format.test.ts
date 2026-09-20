import { describe, expect, it } from 'vitest';

import type { DispatchMetricsReport, Distribution } from './dispatch-metrics';
import type { DispatchParameters } from './dispatch-metrics.format';
import { MEANINGFUL_SEARCH_COUNT, formatDispatchMetrics } from './dispatch-metrics.format';

/**
 * What the measurement report says, and what it refuses to say (issue #114).
 *
 * The report exists so that the first real dispatch traffic produces ADR-0009's
 * five parameters rather than an argument. Two things therefore have to hold,
 * and both are asserted below: **a thin window must announce itself as thin**,
 * because a number read off six searches is the exact failure #114 warns about;
 * and **an empty distribution must read as absent, never as zero**, because a
 * `0.0` in a percentile column is a measurement and a `—` is an admission.
 */

const NO_DATA: Distribution = {
  count: 0,
  mean: null,
  p50: null,
  p75: null,
  p90: null,
  p95: null,
  max: null,
};

function distribution(values: Partial<Distribution> & { count: number }): Distribution {
  return { ...NO_DATA, ...values };
}

/** The values ADR-0009 ships today — the hypotheses the report prints against. */
const SHIPPED: DispatchParameters = {
  initialRadiusM: 3000,
  maxRadiusM: 10000,
  radiusStepSeconds: 30,
  totalTimeoutSeconds: 180,
  maxMastersPerBroadcast: 20,
};

const EMPTY: DispatchMetricsReport = {
  window: { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-11-01T00:00:00.000Z') },
  searches: {
    searches: 0,
    accepted: 0,
    noMasterFound: 0,
    cancelled: 0,
    otherOutcome: 0,
    stillOpen: 0,
    noMasterFoundRate: null,
    timeToAcceptSeconds: NO_DATA,
    acceptRound: NO_DATA,
    acceptRadiusM: NO_DATA,
    acceptDistanceM: NO_DATA,
    offersPerSearch: NO_DATA,
  },
  rounds: [],
  offers: {
    offers: 0,
    outstanding: 0,
    declined: 0,
    expired: 0,
    accepted: 0,
    lost: 0,
    expiryRate: null,
    declineRate: null,
    timeToRespondSeconds: NO_DATA,
    distanceM: NO_DATA,
  },
};

/** A window with enough finished searches to be worth reading. */
function populated(): DispatchMetricsReport {
  const accepted = MEANINGFUL_SEARCH_COUNT;

  return {
    ...EMPTY,
    searches: {
      ...EMPTY.searches,
      searches: accepted + 5,
      accepted,
      noMasterFound: 5,
      noMasterFoundRate: 5 / (accepted + 5),
      timeToAcceptSeconds: distribution({ count: accepted, p50: 22.5, p90: 61, p95: 74, max: 119 }),
      acceptRound: distribution({ count: accepted, p50: 1, p90: 3, p95: 3, max: 4 }),
      acceptRadiusM: distribution({ count: accepted, p50: 3000, p90: 5800, p95: 5800, max: 7200 }),
      acceptDistanceM: distribution({
        count: accepted,
        p50: 1420,
        p90: 4100,
        p95: 5200,
        max: 6800,
      }),
      offersPerSearch: distribution({ count: accepted + 5, p50: 9, p95: 26, max: 31 }),
    },
    rounds: [
      {
        round: 1,
        searchesReached: accepted + 5,
        offersSent: 180,
        acceptsWon: 21,
        mastersPerBroadcast: distribution({ count: 35, p50: 5, p95: 9, max: 11 }),
        radiusM: distribution({ count: 35, p50: 3000, max: 3000 }),
      },
      {
        round: 2,
        searchesReached: 14,
        offersSent: 96,
        acceptsWon: 6,
        mastersPerBroadcast: distribution({ count: 14, p50: 7, p95: 20, max: 20 }),
        radiusM: distribution({ count: 14, p50: 4400, max: 4400 }),
      },
    ],
    offers: {
      ...EMPTY.offers,
      offers: 276,
      accepted: 30,
      declined: 44,
      expired: 96,
      lost: 106,
      expiryRate: 96 / (96 + 44 + 30),
      declineRate: 44 / (96 + 44 + 30),
      timeToRespondSeconds: distribution({ count: 74, p50: 8.2, p90: 24.4, p95: 28.9, max: 30 }),
      distanceM: distribution({ count: 276, p50: 2600, p95: 8100, max: 9900 }),
    },
  };
}

describe('formatDispatchMetrics', () => {
  it('warns that a thin window is an anecdote rather than a measurement', () => {
    const output = formatDispatchMetrics(EMPTY, SHIPPED);

    expect(output).toContain('WARNING');
    expect(output).toContain('do not put them in an ADR');
  });

  it('drops the warning once enough searches have finished', () => {
    const output = formatDispatchMetrics(populated(), SHIPPED);

    expect(output).not.toContain('WARNING');
  });

  it('shows an unobserved distribution as absent, not as zero', () => {
    const output = formatDispatchMetrics(EMPTY, SHIPPED);

    expect(output).toContain('time to accept (s) no data');
    expect(output).toContain('NO_MASTER_FOUND    —');
    expect(output).not.toContain('p50 0.0');
  });

  it('prints every configured parameter next to the evidence for it', () => {
    const output = formatDispatchMetrics(populated(), SHIPPED);

    expect(output).toContain('DISPATCH_INITIAL_RADIUS_M = 3000');
    expect(output).toContain('DISPATCH_MAX_RADIUS_M = 10000');
    expect(output).toContain('DISPATCH_RADIUS_STEP_SECONDS = 30');
    expect(output).toContain('DISPATCH_TOTAL_TIMEOUT_SECONDS = 180');
    expect(output).toContain('DISPATCH_MAX_MASTERS_PER_BROADCAST = 20');

    // The accept-distance tail is the evidence the two radius parameters are
    // read against; printing the parameter without it would be decoration.
    expect(output).toContain('accept distance p95/max: 5200 / 6800 m');
    expect(output).toContain('time to accept p90/p95/max: 61.0 / 74.0 / 119.0 s');
  });

  it('states no recommended value for any parameter', () => {
    const output = formatDispatchMetrics(populated(), SHIPPED);

    // #114: the report collects evidence; the superseding ADR decides. A
    // formatter that printed a suggestion would turn one person's judgement
    // into an apparently computed fact, which is the failure the issue names.
    expect(output).toContain('No value below is derived here');
    expect(output.toLowerCase()).not.toContain('recommend');
    expect(output.toLowerCase()).not.toContain('suggest');
  });

  it('counts the rounds that reached the broadcast cap', () => {
    const output = formatDispatchMetrics(populated(), SHIPPED);

    // Round 2 peaked at exactly 20 offers, the configured cap; round 1 at 11.
    expect(output).toContain('rounds that hit the cap: 1 of 2');
  });

  it('lists each round that broadcast, and says so when none did', () => {
    const output = formatDispatchMetrics(populated(), SHIPPED);
    const header = 'round  searches  offers  accepts  radius(m)  masters per broadcast';

    // Columns line up under the header, because a round table read by eye
    // during a tuning discussion is the whole point of the text output.
    expect(output).toContain(header);
    expect(output).toContain('    1        35     180       21       3000  n=35');
    expect(output).toContain('    2        14      96        6       4400  n=14');

    expect(formatDispatchMetrics(EMPTY, SHIPPED)).toContain('no broadcasts in this window');
  });

  it('names the window it measured, so a printed report is self-describing', () => {
    const output = formatDispatchMetrics(EMPTY, SHIPPED);

    expect(output).toContain('2026-10-01T00:00:00.000Z .. 2026-11-01T00:00:00.000Z');
  });
});
