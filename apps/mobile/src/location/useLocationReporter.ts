import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppDispatch } from '../store/hooks';

import { locationAdapter } from './location-adapter';
import type { MasterReportingState } from './location-budget';
import { masterLocationApi } from './location-endpoints';
import type { LocationPort, Position } from './location-port';
import { createLocationReporter } from './reporter';
import type { LocationReporter, ReporterStatus, SendOutcome } from './reporter';

const RATE_LIMITED = 429;

/**
 * Turns an RTK Query failure into the one distinction the reporter acts on.
 *
 * A `429` is the server stating its own budget and is answered by backing off;
 * everything else — offline, a 409 because the master went offline on another
 * device, a 500 — is answered by waiting for the next floor. The reporter
 * never retries either.
 */
function outcomeOf(error: unknown): SendOutcome {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status?: unknown };
    if (status === RATE_LIMITED) {
      return 'rate-limited';
    }
  }
  return 'failed';
}

const IDLE: ReporterStatus = {
  state: 'offline',
  reporting: false,
  stale: false,
  blocked: false,
};

/**
 * Runs the master's position reporter for as long as this tree is mounted
 * (issue #171).
 *
 * **One reporter, driven by the master's state.** The state arrives from the
 * caller rather than being inferred here, because what a master is doing is
 * the availability query's answer plus — one day — their assigned order, and a
 * hook that read both would be the second place that decides what "online"
 * means.
 *
 * **`setState` is idempotent and the reporter is built once.** Both matter on
 * a mid-range Android: the state comes from a query that re-renders far more
 * often than it changes, and restarting a GNSS subscription per render is the
 * battery cost this module exists to avoid.
 *
 * **It never prompts.** The permission question belongs to a call site that
 * has earned it — the availability toggle, on the way online — exactly as
 * `usePushRegistration` leaves the notification prompt to `usePushAccessPrompt`.
 * A reporter that prompted would ask a master for their location the first
 * time this hook happened to mount.
 */
export interface LocationReporterOptions {
  /**
   * Keep reporting while the app is backgrounded (issue #171). The caller
   * decides — the master is on a job and granted background access — and the
   * reporter only honours it for a state that reports at all.
   */
  readonly background?: boolean;
  /** Injected by tests; the app always uses the `expo-location` adapter. */
  readonly port?: LocationPort;
}

export function useLocationReporter(
  state: MasterReportingState,
  { background = false, port = locationAdapter }: LocationReporterOptions = {},
): ReporterStatus {
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<ReporterStatus>(IDLE);

  /**
   * Held in a ref so the reporter is never rebuilt: `useMemo` is a performance
   * hint that React may discard, and discarding this one would orphan a live
   * GNSS subscription.
   */
  const reporter = useRef<LocationReporter | null>(null);

  const send = useMemo(
    () =>
      async (position: Position): Promise<SendOutcome> => {
        try {
          await dispatch(masterLocationApi.endpoints.reportLocation.initiate(position)).unwrap();
          return 'sent';
        } catch (error) {
          return outcomeOf(error);
        }
      },
    [dispatch],
  );

  useEffect(() => {
    reporter.current ??= createLocationReporter({ location: port, send, onStatus: setStatus });
    const running = reporter.current;

    void running.setState(state, { background });

    return () => {
      // Only on unmount, and `setState` handles every change in between. A
      // cleanup that stopped on every state change would tear the subscription
      // down and build it again for a retune the reporter can do in place.
    };
  }, [background, port, send, state]);

  useEffect(() => {
    return () => {
      void reporter.current?.stop();
      reporter.current = null;
    };
  }, []);

  return status;
}
