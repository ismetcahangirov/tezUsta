import { ESTIMATE_DETOUR_FACTOR, ESTIMATE_SPEED_KMH } from '../../infra/geo/driving-estimate';
import { heading, line, num, percent } from '../dispatch/dispatch-metrics.format';
import type { ArrivalMetricsReport, PromiseKeeping } from './arrival-metrics';
import { CALIBRATION_MIN_DISTANCE_M } from './arrival-metrics';

/**
 * Below this many calibration trips the suggested speeds are an anecdote.
 * The same idea, and the same number, as `MEANINGFUL_SEARCH_COUNT`.
 */
export const MEANINGFUL_TRIP_COUNT = 30;

function keepingLines(label: string, keeping: PromiseKeeping): string[] {
  return [
    `${label.padEnd(18)} measured ${String(keeping.measured)}, on time ${String(keeping.onTime)} (${percent(keeping.onTimeShare)})`,
    `${''.padEnd(18)} late by (s) ${line(keeping.lateBySeconds, 0)}`,
  ];
}

/**
 * The arrival report as text, for the operator who ran the command
 * (issue #410). `--json` prints the report object instead.
 */
export function formatArrivalMetrics(report: ArrivalMetricsReport): string {
  const { calibration } = report;
  const out: string[] = [];

  out.push('TezUsta arrival promises — ADR-0055 § 10–11 (issue #410)');
  out.push(
    `window: ${report.window.from.toISOString()} .. ${report.window.to.toISOString()} (by accept)`,
  );

  if (calibration.trips < MEANINGFUL_TRIP_COUNT) {
    out.push(
      `WARNING: only ${String(calibration.trips)} arrived trips of at least ` +
        `${String(CALIBRATION_MIN_DISTANCE_M)} m in this window. Below ` +
        `${String(MEANINGFUL_TRIP_COUNT)} these numbers are an anecdote, not a ` +
        'measurement — do not change the estimate on them.',
    );
  }

  out.push(heading('Promises'));
  out.push(`accepts            ${String(report.accepts)}`);
  out.push(`promised           ${String(report.promised)}`);
  out.push(`  from a route     ${String(report.promisedByRoute)}`);
  out.push(`  from an estimate ${String(report.promisedByEstimate)}`);
  out.push(`master arrived     ${String(report.arrived)}`);

  out.push(heading('Kept'));
  out.push(...keepingLines('all', report.overall));
  out.push(...keepingLines('route', report.route));
  out.push(...keepingLines('estimate', report.estimate));

  out.push(heading('Estimate calibration'));
  out.push(
    `current            ${String(ESTIMATE_DETOUR_FACTOR)} × straight line at ` +
      `${String(ESTIMATE_SPEED_KMH)} km/h = ${num(calibration.currentSecondsPerMetre, 3)} s per metre`,
  );
  out.push(`trips ≥ ${String(CALIBRATION_MIN_DISTANCE_M)} m       ${String(calibration.trips)}`);
  out.push(`real s per metre   ${line(calibration.secondsPerMetre, 3)}`);
  out.push(`current covers     ${percent(calibration.currentCoverage)} of these trips`);
  out.push(
    `speed covering 75% ${num(calibration.speedKmhCovering75, 1)} km/h, ` +
      `90% ${num(calibration.speedKmhCovering90, 1)} km/h (at the same ${String(ESTIMATE_DETOUR_FACTOR)} detour)`,
  );
  out.push(
    'The estimate should err long (ADR-0055 § 10): pick a speed that covers most real trips, ' +
      'and change it in driving-estimate.ts with an ADR, never by configuration.',
  );

  return `${out.join('\n')}\n`;
}
