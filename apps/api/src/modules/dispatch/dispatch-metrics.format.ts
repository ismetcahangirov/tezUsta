import type { DispatchTimings } from './dispatch-schedule';
import type { Distribution, DispatchMetricsReport } from './dispatch-metrics';

/**
 * Renders a {@link DispatchMetricsReport} for a human deciding ADR-0009's five
 * parameters (issue #114).
 *
 * **Pure, and separate from the query, so it is testable without a database.**
 * The query's correctness is a claim about SQL and needs Postgres to check;
 * that the report puts the right distribution next to the right parameter is a
 * claim about this file, and a suite that needed a live server to check it
 * would be run less often than one that does not.
 *
 * **It states no recommendation.** Every line below is either a number the
 * database produced or a question that number answers. Which value to ship is
 * a trade-off — a wider initial radius reaches more masters and sends more
 * people further for the same fare — and a trade-off is decided in an ADR by a
 * person, not printed by a formatter. The deliberate shape of the parameter
 * section is *configured value, observed evidence, the question* — never a
 * fourth column with a suggestion in it.
 */

/** The five values ADR-0009 § Parameters names, as currently configured. */
export interface DispatchParameters extends DispatchTimings {
  readonly maxMastersPerBroadcast: number;
}

function num(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits);
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** `n=… p50 … p75 … p90 … p95 … max … mean …`, or a bare `no data`. */
function line(distribution: Distribution, digits = 1): string {
  if (distribution.count === 0) {
    return 'no data';
  }

  return [
    `n=${String(distribution.count)}`,
    `p50 ${num(distribution.p50, digits)}`,
    `p75 ${num(distribution.p75, digits)}`,
    `p90 ${num(distribution.p90, digits)}`,
    `p95 ${num(distribution.p95, digits)}`,
    `max ${num(distribution.max, digits)}`,
    `mean ${num(distribution.mean, digits)}`,
  ].join('  ');
}

function heading(title: string): string {
  return `\n${title}\n${'-'.repeat(title.length)}`;
}

/**
 * Whether the window holds enough finished searches to say anything.
 *
 * **Named, printed, and deliberately crude.** There is no statistical claim
 * here — thirty is not a confidence interval — and pretending otherwise would
 * be the same error #114 warns against in a different costume. What it is: a
 * visible reminder, at the top of the report, that a handful of searches is an
 * anecdote, so that a number read off a quiet Tuesday does not end up in an
 * ADR with the word "measured" next to it.
 */
export const MEANINGFUL_SEARCH_COUNT = 30;

export function formatDispatchMetrics(
  report: DispatchMetricsReport,
  parameters: DispatchParameters,
): string {
  const { searches, offers, rounds, window } = report;
  const finished = searches.accepted + searches.noMasterFound;
  const out: string[] = [];

  out.push('TezUsta dispatch measurement — ADR-0009 § Parameters (issue #114)');
  out.push(`window: ${window.from.toISOString()} .. ${window.to.toISOString()} (by search start)`);

  if (finished < MEANINGFUL_SEARCH_COUNT) {
    out.push(
      `WARNING: only ${String(finished)} finished searches in this window ` +
        `(accepted + no-master-found). Below ${String(MEANINGFUL_SEARCH_COUNT)} these numbers ` +
        'are an anecdote, not a measurement — do not put them in an ADR.',
    );
  }

  out.push(heading('Searches'));
  out.push(`total              ${String(searches.searches)}`);
  out.push(`accepted           ${String(searches.accepted)}`);
  out.push(`no master found    ${String(searches.noMasterFound)}`);
  out.push(`cancelled          ${String(searches.cancelled)}`);
  out.push(`other outcome      ${String(searches.otherOutcome)}`);
  out.push(`still searching    ${String(searches.stillOpen)}`);
  out.push(`NO_MASTER_FOUND    ${percent(searches.noMasterFoundRate)} of finished searches`);
  out.push(`time to accept (s) ${line(searches.timeToAcceptSeconds)}`);
  out.push(`accept round       ${line(searches.acceptRound, 2)}`);
  out.push(`accept radius (m)  ${line(searches.acceptRadiusM, 0)}`);
  out.push(`accept distance(m) ${line(searches.acceptDistanceM, 0)}`);
  out.push(`offers per search  ${line(searches.offersPerSearch, 1)}`);

  out.push(heading('Rounds'));
  if (rounds.length === 0) {
    out.push('no broadcasts in this window');
  } else {
    out.push('round  searches  offers  accepts  radius(m)  masters per broadcast');
    for (const round of rounds) {
      out.push(
        [
          String(round.round).padStart(5),
          String(round.searchesReached).padStart(10),
          String(round.offersSent).padStart(8),
          String(round.acceptsWon).padStart(9),
          num(round.radiusM.p50, 0).padStart(11),
          `  ${line(round.mastersPerBroadcast, 1)}`,
        ].join(''),
      );
    }
  }

  out.push(heading('Offers'));
  out.push(`total              ${String(offers.offers)}`);
  out.push(`accepted           ${String(offers.accepted)}`);
  out.push(`declined           ${String(offers.declined)}`);
  out.push(`expired            ${String(offers.expired)}`);
  out.push(`lost (pre-empted)  ${String(offers.lost)}`);
  out.push(`still outstanding  ${String(offers.outstanding)}`);
  out.push(`expiry rate        ${percent(offers.expiryRate)} of accepted+declined+expired`);
  out.push(`decline rate       ${percent(offers.declineRate)} of accepted+declined+expired`);
  out.push(`time to respond(s) ${line(offers.timeToRespondSeconds)}`);
  out.push(`offered distance(m)${line(offers.distanceM, 0)}`);

  out.push(heading('ADR-0009 § Parameters — configured value, and its evidence'));
  out.push('No value below is derived here. Each line pairs what is shipped with what');
  out.push('the data says about it; the trade-off is decided in the superseding ADR.');
  out.push('');

  out.push(`DISPATCH_INITIAL_RADIUS_M = ${String(parameters.initialRadiusM)}`);
  out.push(
    `  accept distance p50/p90: ${num(searches.acceptDistanceM.p50, 0)} / ` +
      `${num(searches.acceptDistanceM.p90, 0)} m`,
  );
  out.push(
    `  round 1 won ${String(rounds[0]?.acceptsWon ?? 0)} of ${String(searches.accepted)} accepts`,
  );
  out.push('  Q: does round 1 already hold the supply, or is it too tight to matter?');
  out.push('');

  out.push(`DISPATCH_MAX_RADIUS_M = ${String(parameters.maxRadiusM)}`);
  out.push(
    `  accept distance p95/max: ${num(searches.acceptDistanceM.p95, 0)} / ` +
      `${num(searches.acceptDistanceM.max, 0)} m`,
  );
  out.push(`  NO_MASTER_FOUND rate: ${percent(searches.noMasterFoundRate)}`);
  out.push('  Q: are searches failing for want of reach, or is nobody accepting at range?');
  out.push('');

  out.push(`DISPATCH_RADIUS_STEP_SECONDS = ${String(parameters.radiusStepSeconds)}`);
  out.push(
    `  time to respond p90/p95: ${num(offers.timeToRespondSeconds.p90)} / ` +
      `${num(offers.timeToRespondSeconds.p95)} s`,
  );
  out.push(`  expiry rate: ${percent(offers.expiryRate)}`);
  out.push('  Q: is an offer being withdrawn from masters who were still deciding?');
  out.push('     (the step is also the offer lifetime — see offerExpiresAt)');
  out.push('');

  out.push(`DISPATCH_TOTAL_TIMEOUT_SECONDS = ${String(parameters.totalTimeoutSeconds)}`);
  out.push(
    `  time to accept p90/p95/max: ${num(searches.timeToAcceptSeconds.p90)} / ` +
      `${num(searches.timeToAcceptSeconds.p95)} / ${num(searches.timeToAcceptSeconds.max)} s`,
  );
  out.push(
    `  accept round p95/max: ${num(searches.acceptRound.p95, 2)} / ` +
      `${num(searches.acceptRound.max, 0)}`,
  );
  out.push('  Q: how many accepts would a shorter window have given up on?');
  out.push('');

  out.push(`DISPATCH_MAX_MASTERS_PER_BROADCAST = ${String(parameters.maxMastersPerBroadcast)}`);
  const atCap = rounds.filter(
    (round) => (round.mastersPerBroadcast.max ?? 0) >= parameters.maxMastersPerBroadcast,
  );
  out.push(`  rounds that hit the cap: ${String(atCap.length)} of ${String(rounds.length)}`);
  out.push(
    `  offers per search p50/p95: ${num(searches.offersPerSearch.p50)} / ` +
      `${num(searches.offersPerSearch.p95)}`,
  );
  out.push('  Q: is the cap what limits reach, or is supply running out first?');

  return `${out.join('\n')}\n`;
}
