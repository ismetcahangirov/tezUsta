import type { MasterLocationReceipt } from '@tezusta/types';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/api-slice';
import { locationAdapter } from '../location/location-adapter';
import type { LocationPermission } from '../location/location-permission';
import type { LocationPort } from '../location/location-port';
import { useLocationReporter } from '../location/useLocationReporter';
import { useGetAvailabilityQuery } from '../master-availability/master-availability-endpoints';
import { useOrderRoom } from '../realtime/useOrderRoom';
import { useRealtimeConnection } from '../realtime/RealtimeProvider';
import { useAppDispatch } from '../store/hooks';
import { jobStepFor, reportingStateFor } from './job-steps';
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

/**
 * Background access for the job with `orderId`, asked for once, at accept.
 *
 * **Asked when a job appears, and at no other moment** — which is accept, or
 * the first launch after one. Never at onboarding and never when going online,
 * where "Always" is denied because nothing yet explains why it is needed
 * (`realtime-architecture.md` § Background location). Keyed by the order, so
 * a master who declined is not asked again on every render of the same job,
 * and is asked afresh on the next one.
 *
 * Only after foreground access is already granted: iOS will not grant "Always"
 * to an app that does not hold "While using", and asking in that order is what
 * the platform expects.
 */
function useBackgroundAccess(
  port: LocationPort,
  orderId: string | undefined,
): LocationPermission | null {
  const [answer, setAnswer] = useState<{ orderId: string; permission: LocationPermission } | null>(
    null,
  );

  useEffect(() => {
    if (orderId === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      if ((await port.permission()) !== 'granted') {
        return;
      }

      let permission = await port.backgroundPermission();
      if (permission === 'askable') {
        permission = await port.requestBackgroundPermission();
      }

      if (!cancelled) {
        setAnswer({ orderId, permission });
      }
    })().catch(() => {
      // A platform that cannot answer leaves the job on foreground updates,
      // which is the same outcome as a denial and is not worth an error.
    });

    return () => {
      cancelled = true;
    };
  }, [orderId, port]);

  return answer !== null && answer.orderId === orderId ? answer.permission : null;
}

export interface MasterWorkProviderProps {
  readonly children: React.ReactNode;
  /** Injected by tests; the app always uses the `expo-location` adapter. */
  readonly port?: LocationPort;
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
export function MasterWorkProvider({
  children,
  port = locationAdapter,
}: MasterWorkProviderProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const availability = useGetAvailabilityQuery();
  const job = useCurrentJobQuery();
  const master = useOwnMasterQuery();

  const current = job.currentData?.job ?? null;
  const currentOrderId = current?.orderId ?? null;

  /**
   * **The stop rule that works with the socket closed** (issue #171). The
   * socket closes when the app is backgrounded, so a customer's cancellation
   * seldom reaches a driving master as a frame; but the background session
   * keeps reporting, and each report's answer names the job the server still
   * has this master on. When that disagrees with the job this app believes
   * in, the job is re-read — it answers `null`, `onJob` goes false, and the
   * background session ends within one report rather than at the next time
   * the master happens to open the app.
   *
   * Only while a read has settled (`currentData` defined): comparing against
   * a job that has not loaded yet would re-read on every early report.
   */
  const jobLoaded = job.currentData !== undefined;
  const onReceipt = useCallback(
    (receipt: MasterLocationReceipt) => {
      if (jobLoaded && receipt.engagedOrderId !== currentOrderId) {
        dispatch(api.util.invalidateTags(['MasterJob']));
      }
    },
    [currentOrderId, dispatch, jobLoaded],
  );
  const onJob = current !== null && jobStepFor(current.status) !== null;

  const backgroundAccess = useBackgroundAccess(port, onJob ? current.orderId : undefined);

  /**
   * **Background runs only while `onJob`, and that is the whole stop rule.**
   * Completion, a customer cancellation and a re-dispatch all make the job
   * read answer `null`, `onJob` goes false, the reporter's mode changes, and
   * it removes the subscription — which ends the background session. There is
   * no separate "stop background" call to forget on one of those paths.
   */
  const reporter = useLocationReporter(
    reportingStateFor(availability.currentData?.isAvailable === true, current?.status ?? null),
    { background: onJob && backgroundAccess === 'granted', port, onReceipt },
  );

  useMasterRoom(master.currentData?.id);
  useOrderRoom(current?.orderId);

  // Anything but a grant, once asked: a dismissed dialog leaves "askable",
  // and the master is still without background tracking on this job.
  const backgroundDenied = onJob && backgroundAccess !== null && backgroundAccess !== 'granted';

  const value = useMemo<MasterWorkStatus>(
    () => ({ reporter, backgroundDenied }),
    [reporter, backgroundDenied],
  );

  return <MasterWorkContext.Provider value={value}>{children}</MasterWorkContext.Provider>;
}
