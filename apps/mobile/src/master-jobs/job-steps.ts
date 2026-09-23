import type { OrderStatus } from '@tezusta/types';

import type { MasterReportingState } from '../location';

/**
 * The master's half of the transition table, as the screen needs it
 * (issue #199).
 *
 * **A presentation of the server's table, not a second authority.** The
 * server's `order-lifecycle.ts` decides, on every request, whether this caller
 * may walk this edge; this file only decides which button to draw. If the two
 * ever disagree the server refuses, the job is re-read, and the screen shows
 * the order as it is — the cost is a wasted tap, never a wrong status.
 *
 * One table rather than a branch per status in the screen, so the next edge
 * ADR-0015 adds is one row here.
 */
interface JobStep {
  /** The one forward move the assigned master may make from here. */
  readonly next: OrderStatus | null;
  /**
   * Whether "I can't come" is on offer. ADR-0015: re-dispatch leaves
   * `ACCEPTED`, `MASTER_ON_THE_WAY` and `MASTER_ARRIVED`, and deliberately not
   * `IN_PROGRESS` — once work has started, a different master cannot pick the
   * job up.
   */
  readonly canHandBack: boolean;
  /**
   * What the position reporter should be doing (issue #171).
   *
   * `travelling` until the master says they have arrived, because that is the
   * stretch the customer is watching the marker for — including `ACCEPTED`,
   * where the master has taken the job and is about to set off. `working`
   * afterwards: the master is standing in the customer's kitchen and the
   * marker has stopped being interesting.
   */
  readonly reporting: MasterReportingState;
}

const JOB_STEPS: Readonly<Partial<Record<OrderStatus, JobStep>>> = {
  ACCEPTED: { next: 'MASTER_ON_THE_WAY', canHandBack: true, reporting: 'travelling' },
  MASTER_ON_THE_WAY: { next: 'MASTER_ARRIVED', canHandBack: true, reporting: 'travelling' },
  MASTER_ARRIVED: { next: 'IN_PROGRESS', canHandBack: true, reporting: 'working' },
  IN_PROGRESS: { next: 'COMPLETED', canHandBack: false, reporting: 'working' },
};

/** The step a job in `status` is at, or `null` for a status that is not a job. */
export function jobStepFor(status: OrderStatus): JobStep | null {
  return JOB_STEPS[status] ?? null;
}

/**
 * What the reporter does, from the two facts the server holds: whether the
 * master is available, and the status of the job they are on.
 *
 * **Availability wins.** The server refuses a report from a master who has
 * turned themselves off (`master-location.service.ts`), and a phone that kept
 * reporting would be collecting the movements of someone who believes it has
 * stopped — so an unavailable master reports nothing, job or no job.
 */
export function reportingStateFor(
  isAvailable: boolean,
  jobStatus: OrderStatus | null,
): MasterReportingState {
  if (!isAvailable) {
    return 'offline';
  }
  if (jobStatus === null) {
    return 'online';
  }
  return jobStepFor(jobStatus)?.reporting ?? 'online';
}
