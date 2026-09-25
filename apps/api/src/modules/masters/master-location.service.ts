import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MasterLocationReceipt } from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { MasterRow } from '../../infra/database/schema/masters';
import { MasterPresenceService } from '../../infra/presence/master-presence.service';
import type { Actor } from '../auth/auth.types';
import { MasterAvailabilityService } from './master-availability.service';
import { LocationImplausibleError } from './master-location.errors';
import { isImplausibleJump } from './master-location.plausibility';
import { MasterLocationRegistry } from './master-location.registry';
import { MasterLocationRepository } from './master-location.repository';
import type { ReportLocationRequest } from './master-location.schema';
import { MastersRepository } from './masters.repository';

/**
 * Where a master says they are (issue #98).
 *
 * This is the write half of the product's defining query: dispatch reads the
 * latest row per master and ranks by distance (ADR-0003,
 * `docs/architecture/database-architecture.md` § The nearby-masters query), and
 * nothing gets into that table except through here.
 *
 * **A position report is a heartbeat that also carries coordinates.** An app
 * sending its position is by definition running and reachable, so charging it
 * a second HTTP round trip to say so would spend a mid-range Android's battery
 * on information the server already has —
 * `docs/architecture/realtime-architecture.md` aligns the heartbeat interval
 * with the reporting interval for precisely this reason. So presence is
 * refreshed here, and the reply carries the whole availability state.
 *
 * **Two refusals, and they are different refusals.** A master who is not
 * `active` may not be dispatched, so their position is of no use and their
 * movements are not ours to collect. A master who is `is_available = false`
 * turned themselves off, possibly on another device, and an app still
 * reporting after that is an app whose user believes it has stopped — the
 * failure `docs/product/master-flow.md` calls out as the one that costs the
 * product a master's trust permanently.
 *
 * **Nothing here logs a coordinate, at any level** (CLAUDE.md §11). The
 * latitude and longitude reach exactly two places: the Zod-validated body, and
 * a parameterised INSERT. Not a debug line, not an error message, not the
 * response.
 */
@Injectable()
export class MasterLocationService {
  private readonly logger = new Logger(MasterLocationService.name);

  constructor(
    private readonly repository: MasterLocationRepository,
    private readonly masters: MastersRepository,
    private readonly availability: MasterAvailabilityService,
    private readonly presence: MasterPresenceService,
    private readonly fanOut: MasterLocationRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Records one position and refreshes presence, in that order.
   *
   * Eligibility is checked **before** the row is written, because an
   * ineligible master's position is data we have no reason to hold — a
   * rejected report must leave nothing behind.
   *
   * Presence is refreshed **after** the row lands, so the failure modes stay
   * the conservative ones. A crash between the two leaves a master with a
   * fresh position and no liveness, which reads as "offline" and costs at most
   * one dispatch round; the opposite order would advertise a master as live on
   * a position the database never took.
   *
   * The fan-out is raised **last**, and it is the only step allowed to fail
   * silently (issue #169). A master with no active order fans out nothing —
   * their report still lands in `master_locations` and still feeds dispatch;
   * it is simply not broadcast. Which order, and whether this report is inside
   * the throttle window, are `modules/realtime`'s questions, and nothing here
   * knows a socket exists (`master-location.registry.ts`).
   *
   * **An impossible step is refused before anything else happens** (issue
   * #274, ADR-0044). The repository measures the step from the previous fix
   * inside the write transaction and this rule decides; a refusal writes no
   * row, refreshes no presence and fans nothing out, so a spoofed fix reaches
   * neither dispatch nor a customer's map. Presence is left alone rather than
   * dropped: the app is plainly alive, and one bad fix is not a reason to take
   * an honest master out of the next broadcast at their last good position.
   */
  async report(actor: Actor, report: ReportLocationRequest): Promise<MasterLocationReceipt> {
    const master = await this.requireOwnProfile(actor);

    await this.availability.assertOnline(
      master,
      'You are offline, so your position is not being recorded.',
    );

    const { maxSpeedKmh, jumpFloorMeters } = this.config.masterLocation;
    const recorded = await this.repository.record(
      {
        masterId: master.id,
        latitude: report.latitude,
        longitude: report.longitude,
      },
      (step) => isImplausibleJump(step, { maxSpeedKmh, jumpFloorMeters }),
    );

    if (recorded === null) {
      // The master id and nothing else: no coordinate, no distance, no speed —
      // each of those is derived from a position (CLAUDE.md §11). Counting
      // these lines per master is how a spoofing app is noticed.
      this.logger.warn(`Refused an implausible position report from master ${master.id}.`);
      throw new LocationImplausibleError();
    }

    await this.presence.refresh(master.id);

    await this.fanOut.reported({
      masterId: master.id,
      latitude: report.latitude,
      longitude: report.longitude,
      recordedAt: recorded.recordedAt,
    });

    return {
      recordedAt: recorded.recordedAt.toISOString(),
      presence: await this.availability.describe(master),
      engagedOrderId: await this.repository.findEngagedOrderId(master.id),
    };
  }

  /**
   * The caller's own master profile, or 404.
   *
   * 404 rather than 403: the `master` role gate has already run, so a caller
   * reaching this point holds the role and simply has no live profile — the
   * same answer `GET /masters/me` gives for the same situation.
   */
  private async requireOwnProfile(actor: Actor): Promise<MasterRow> {
    const row = await this.masters.findByUserId(actor.userId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }
}
