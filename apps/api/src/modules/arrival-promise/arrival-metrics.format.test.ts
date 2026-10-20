import { describe, expect, it } from 'vitest';

import type { Distribution } from '../dispatch/dispatch-metrics';
import type { ArrivalMetricsReport } from './arrival-metrics';
import { CURRENT_SECONDS_PER_METRE } from './arrival-metrics';
import { formatArrivalMetrics, MEANINGFUL_TRIP_COUNT } from './arrival-metrics.format';

const NONE: Distribution = {
  count: 0,
  mean: null,
  p50: null,
  p75: null,
  p90: null,
  p95: null,
  max: null,
};

function distribution(count: number, p50: number): Distribution {
  return { count, mean: p50, p50, p75: p50, p90: p50, p95: p50, max: p50 };
}

function report(trips: number): ArrivalMetricsReport {
  return {
    window: {
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-12-01T00:00:00.000Z'),
    },
    accepts: 120,
    promised: 118,
    promisedByRoute: 110,
    promisedByEstimate: 8,
    arrived: 100,
    overall: {
      measured: 98,
      onTime: 80,
      onTimeShare: 80 / 98,
      lateBySeconds: distribution(98, -45),
    },
    route: { measured: 90, onTime: 76, onTimeShare: 76 / 90, lateBySeconds: distribution(90, -50) },
    estimate: { measured: 8, onTime: 4, onTimeShare: 0.5, lateBySeconds: distribution(8, 10) },
    calibration: {
      trips,
      secondsPerMetre: trips === 0 ? NONE : distribution(trips, 0.21),
      currentSecondsPerMetre: CURRENT_SECONDS_PER_METRE,
      currentCoverage: trips === 0 ? null : 0.7,
      speedKmhCovering75: trips === 0 ? null : 17.25,
      speedKmhCovering90: trips === 0 ? null : 14.5,
    },
  };
}

describe('formatArrivalMetrics (issue #410)', () => {
  it('warns that a thin window is an anecdote', () => {
    expect(formatArrivalMetrics(report(MEANINGFUL_TRIP_COUNT - 1))).toContain(
      `WARNING: only ${String(MEANINGFUL_TRIP_COUNT - 1)} arrived trips`,
    );
  });

  it('says nothing of the kind once there is enough to measure', () => {
    expect(formatArrivalMetrics(report(MEANINGFUL_TRIP_COUNT))).not.toContain('WARNING');
  });

  it('prints the counts, the share kept, and the speeds that would cover real trips', () => {
    const text = formatArrivalMetrics(report(64));

    expect(text).toContain('accepts            120');
    expect(text).toContain('measured 98, on time 80 (81.6%)');
    expect(text).toContain('current covers     70.0% of these trips');
    expect(text).toContain('speed covering 75% 17.3 km/h, 90% 14.5 km/h');
    expect(text).toContain('= 0.252 s per metre');
  });

  it('prints a dash, never a zero, where there is no data', () => {
    const text = formatArrivalMetrics(report(0));

    expect(text).toContain('real s per metre   no data');
    expect(text).toContain('current covers     — of these trips');
    expect(text).toContain('speed covering 75% — km/h');
  });
});
