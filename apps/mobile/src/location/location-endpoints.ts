import type { MasterLocationReceipt } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * What a master's app sends to `POST /masters/me/location`.
 *
 * Written to match the server's `reportLocationSchema` exactly, which is
 * `.strict()` over these two fields and nothing else — a client that invents
 * `accuracy`, `heading` or `lat` is refused with a 422 (issue #98).
 *
 * **Batching happens before this, not in it.** Where the platform hands over
 * several points at once — the background task's deferred batches — they are
 * collapsed to the newest on the device (`background-task.ts#newestOf`), so a
 * batch still costs one request and the one-point contract of #98 stands.
 */
export interface ReportLocationBody {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * The master's position report (issue #171 on this side, #98 on the other).
 *
 * **It invalidates nothing and patches nothing.** The response carries the
 * whole availability state, and it is tempting to write it into
 * `getAvailability` the way the heartbeat does — but a report fires every
 * twelve seconds while travelling, and a cache write per report would
 * re-render the master's screen on a timer for a value that almost never
 * changes. The heartbeat already keeps that entry current, and a report is
 * also a heartbeat server-side (`master-location.service.ts`), so nothing is
 * lost by staying quiet.
 *
 * **No coordinate ever reaches a log**, here or in the reporter (CLAUDE.md
 * §11). The two numbers go from the platform into this body and nowhere else.
 */
export const masterLocationApi = api.injectEndpoints({
  endpoints: (build) => ({
    reportLocation: build.mutation<MasterLocationReceipt, ReportLocationBody>({
      query: (body) => ({ url: '/masters/me/location', method: 'POST', body }),
    }),
  }),
});

export const { useReportLocationMutation } = masterLocationApi;
