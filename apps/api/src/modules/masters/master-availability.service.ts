import { Injectable } from '@nestjs/common';
import type { MasterAvailability } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { MasterRow } from '../../infra/database/schema/masters';
import { MasterPresenceService } from '../../infra/presence/master-presence.service';
import type { Actor } from '../auth/auth.types';
import { MastersRepository } from './masters.repository';
import { MasterNotEligibleError, MastersService } from './masters.service';

/**
 * A heartbeat arrived from a master who is not online.
 *
 * Distinct from the eligibility error on purpose: the client's correct
 * response is different. "You are not verified" means show the verification
 * screen; this means stop beating, because the user turned themselves off —
 * possibly on another device.
 */
export class NotOnlineError extends AppError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'You are offline, so there is no presence to refresh.', 409);
    this.name = 'NotOnlineError';
    Object.setPrototypeOf(this, NotOnlineError.prototype);
  }
}

/**
 * The availability toggle, and the heartbeat that keeps it true (issue #40).
 *
 * "Online" is two facts that must agree, and they live in two places on
 * purpose (`docs/architecture/realtime-architecture.md` § Presence):
 *
 * - **Intent** — `masters.is_available` in Postgres. The master flipped a
 *   switch. It survives a restart, and it is what the app shows.
 * - **Liveness** — a Redis key with a TTL, refreshed by a heartbeat. The app
 *   is actually running and reachable. It expires on its own.
 *
 * Matching requires both. A boolean alone cannot expire, so a phone that died
 * in a tunnel would stay available forever and dispatch would keep offering
 * work to it; a TTL alone would forget that the master ever chose to be
 * online, so a reconnect would silently put them back to work.
 *
 * **The UI must be unambiguous** — `docs/product/master-flow.md` is blunt that
 * "a master who believes they are offline while the app still reports location
 * will lose trust in the product permanently" — which is why every method here
 * returns the whole state rather than an acknowledgement, and why `isLive` is
 * reported separately from `isAvailable` instead of being folded into one
 * cheerful boolean.
 */
@Injectable()
export class MasterAvailabilityService {
  constructor(
    private readonly repository: MastersRepository,
    private readonly masters: MastersService,
    private readonly presence: MasterPresenceService,
  ) {}

  async read(actor: Actor): Promise<MasterAvailability> {
    const master = await this.requireOwnProfile(actor);
    return this.describe(master);
  }

  /**
   * Goes online or offline.
   *
   * Going online is gated on {@link MastersService.assertCanAcceptWork}, which
   * re-reads `verification_status` from the database — so an unverified master
   * cannot start receiving offers, and a suspended one cannot, even holding a
   * token minted before the suspension.
   *
   * The order matters in both directions. Going online writes the intent
   * **first** and the presence second: a live key with no stored intent is a
   * master dispatch cannot explain, whereas an intent with no key yet is just
   * somebody whose first heartbeat has not landed. Going offline clears the
   * presence **first**: the moment that key is gone no dispatch can reach
   * them, which is what "going offline stops reporting immediately" means, and
   * a failure after it leaves a master who is off rather than one who is on.
   */
  async set(actor: Actor, isAvailable: boolean): Promise<MasterAvailability> {
    const master = await this.requireOwnProfile(actor);

    if (isAvailable) {
      await this.masters.assertCanAcceptWork(master.id);
      const updated = await this.setIntent(master, true);
      await this.presence.refresh(master.id);
      return this.describe(updated);
    }

    await this.presence.clear(master.id);
    return this.describe(await this.setIntent(master, false));
  }

  /**
   * Refreshes the presence TTL, and **re-checks eligibility while doing it**.
   *
   * That second half is what makes a mid-shift suspension bite without waiting
   * for dispatch to notice. An admin who suspends a master gets them off the
   * platform within one heartbeat: the presence is dropped, the stored intent
   * is set to offline so the app cannot show them as working after a restart,
   * and the error tells the client to stop.
   *
   * A heartbeat from a master whose intent is already offline is a conflict
   * rather than a silent no-op. Answering 200 would leave an app beating
   * forever against a toggle somebody switched off on another device.
   */
  async heartbeat(actor: Actor): Promise<MasterAvailability> {
    const master = await this.requireOwnProfile(actor);

    if (!master.isAvailable) {
      throw new NotOnlineError();
    }

    try {
      await this.masters.assertCanAcceptWork(master.id);
    } catch (error: unknown) {
      if (error instanceof MasterNotEligibleError) {
        await this.presence.clear(master.id);
        await this.setIntent(master, false);
      }
      throw error;
    }

    await this.presence.refresh(master.id);
    return this.describe({ ...master, isAvailable: true });
  }

  private async setIntent(master: MasterRow, isAvailable: boolean): Promise<MasterRow> {
    const updated = await this.repository.setAvailability(master.id, isAvailable);
    if (updated === undefined) {
      // The profile was soft-deleted between the read and the write.
      throw new NotFoundError();
    }
    return updated;
  }

  /**
   * The whole state, in one shape.
   *
   * Uses the outage-tolerant presence read: this is what the master's own
   * screen renders, and taking the availability screen down because Redis
   * blinked would be worse than briefly reporting the conservative answer.
   * Dispatch reads presence the strict way, because there a Redis error must
   * not look like "nobody is online".
   */
  private async describe(master: MasterRow): Promise<MasterAvailability> {
    const remaining = await this.presence.remainingSecondsOrOffline(master.id);
    return {
      isAvailable: master.isAvailable,
      isLive: remaining !== null,
      expiresInSeconds: remaining,
      heartbeatSeconds: this.presence.heartbeatSeconds,
    };
  }

  private async requireOwnProfile(actor: Actor): Promise<MasterRow> {
    const row = await this.repository.findByUserId(actor.userId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }
}
