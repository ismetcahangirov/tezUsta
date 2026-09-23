import { useEffect, useMemo } from 'react';

import { useLocationReporter } from '../location/useLocationReporter';
import { useGetAvailabilityQuery } from '../master-availability/master-availability-endpoints';
import { useOrderRoom } from '../realtime/useOrderRoom';
import { useRealtimeConnection } from '../realtime/RealtimeProvider';
import { reportingStateFor } from './job-steps';
import { useCurrentJobQuery, useOwnMasterQuery } from './master-jobs-endpoints';
import { MasterWorkContext } from './master-work-context';
import type { MasterWorkStatus } from './master-work-context';

/**
 * Joins the master's own socket room, where offers arrive (#168).
 *
 * The room is named by the master profile's id, which the token does not
 * carry — hence the profile read. The server re-authorizes the join against
 * the caller's own profile (#167), so asking for any other id is refused.
 */
function useMasterRoom(masterId: string | undefined): void {
  const connection = useRealtimeConnection();

  useEffect(() => {
    if (connection === null || masterId === undefined) {
      return;
    }

    connection.join({ kind: 'master', masterId });

    return () => {
      connection.leave({ kind: 'master', masterId });
    };
  }, [connection, masterId]);
}

export interface MasterWorkProviderProps {
  readonly children: React.ReactNode;
}

/**
 * Everything the master's app does while it is open, whichever screen is on
 * top (issues #171 and #199).
 *
 * **Mounted once, at the master's layout, and that is the point.** The
 * reporter used to live in `AvailabilityCard`, which was fine while home was
 * the only screen. With a job screen pushed over it, a reporter owned by a
 * screen is a reporter whose life depends on the navigator keeping that
 * screen mounted — and the state that matters most, `travelling`, is exactly
 * when the master is looking at the other screen.
 *
 * **The reporter's state comes from two server facts and nothing else**:
 * whether the master is available, and the status of the job
 * `GET /masters/me/jobs/current` says they are on ({@link reportingStateFor}).
 * Every change underneath it — an accept, an arrival, a completion, a
 * re-dispatch, a customer cancelling, going offline — reaches one of those two
 * reads, through the master's own mutation or through the socket, and the
 * reporter retunes or stops on the next render. There is no third place that
 * decides what the master is doing, which is what #171 asks for: "a missed one
 * leaves the app reporting at the wrong rate forever".
 *
 * It also holds the two socket rooms the master belongs to: their own, for
 * offers, and their job's, for the customer's moves.
 */
export function MasterWorkProvider({ children }: MasterWorkProviderProps): React.JSX.Element {
  const availability = useGetAvailabilityQuery();
  const job = useCurrentJobQuery();
  const master = useOwnMasterQuery();

  const current = job.currentData?.job ?? null;

  const reporter = useLocationReporter(
    reportingStateFor(availability.currentData?.isAvailable === true, current?.status ?? null),
  );

  useMasterRoom(master.currentData?.id);
  useOrderRoom(current?.orderId);

  const value = useMemo<MasterWorkStatus>(
    () => ({ reporter, backgroundDenied: false }),
    [reporter],
  );

  return <MasterWorkContext.Provider value={value}>{children}</MasterWorkContext.Provider>;
}
