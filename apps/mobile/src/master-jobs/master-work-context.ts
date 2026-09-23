import { createContext, useContext } from 'react';

import type { ReporterStatus } from '../location/reporter';

/**
 * What the master's screens may know about the position reporter.
 *
 * `backgroundDenied` sits beside the reporter's own status because it is the
 * same kind of fact — a thing the master's phone is not doing, which costs the
 * customer their view of the marker — and the screens that warn about one warn
 * about the other.
 */
export interface MasterWorkStatus {
  readonly reporter: ReporterStatus;
  /** True once the master has refused background location for the current job. */
  readonly backgroundDenied: boolean;
}

const IDLE: MasterWorkStatus = {
  reporter: { state: 'offline', reporting: false, stale: false, blocked: false },
  backgroundDenied: false,
};

/**
 * Its own file, with nothing in it but the context, so that
 * `AvailabilityCard` can read the reporter without importing the provider that
 * reads availability — the two would otherwise import each other.
 */
export const MasterWorkContext = createContext<MasterWorkStatus>(IDLE);

/**
 * The reporter's status as the master's shell runs it.
 *
 * Outside the shell — a Storybook story, a component test — this is the idle
 * status rather than an error: nothing is reporting, which is true.
 */
export function useMasterWork(): MasterWorkStatus {
  return useContext(MasterWorkContext);
}
