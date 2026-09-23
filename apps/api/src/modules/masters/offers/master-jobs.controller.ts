import { Controller, Get } from '@nestjs/common';
import type { CurrentMasterJob } from '@tezusta/types';

import { RateLimit } from '../../../common/decorators/rate-limit.decorator';
import { rateLimitByUser } from '../../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../../auth/auth.types';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { Roles } from '../../auth/roles.decorator';
import { MasterJobsService } from './master-jobs.service';

/**
 * The job a master is on (issue #198).
 *
 * `/masters/me/jobs/current`, with no id in it, for the reason every
 * `/masters/me/...` route gives: the master is the caller. A read only —
 * the job moves through `POST /orders/:id/transitions`, which is the one route
 * an order's status changes through, and a second write path here would be a
 * second copy of the transition table's authority.
 *
 * Lives beside the offer feed because it is the feed's other half: an offer
 * accepted there is the job read here, keyed by the same offer id, and both
 * answer from `order_offers` joined to the order as it stands. Its own service,
 * though — see `master-jobs.service.ts` for why.
 */
@Controller('masters/me/jobs')
export class MasterJobsController {
  constructor(private readonly jobs: MasterJobsService) {}

  /**
   * **The feed's budget, not a new one.** The app reads this on mount, on
   * every socket reconnect and on each transition event for its own order — the same cadence class as the
   * feed it sits next to on the master's home, sized from polling rather than
   * from taps (`MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR`). A separate env
   * pair would be a knob nobody has a reason to turn differently.
   */
  @Roles('master')
  @RateLimit({ policy: 'offer-feed', identifier: rateLimitByUser })
  @Get('current')
  async current(@CurrentActor() actor: Actor): Promise<CurrentMasterJob> {
    return this.jobs.current(actor);
  }
}
