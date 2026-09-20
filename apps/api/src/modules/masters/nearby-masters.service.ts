import { Inject, Injectable } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { MasterPresenceService } from '../../infra/presence/master-presence.service';
import type { NearbyMasterCandidate, NearbyMastersQuery } from './nearby-masters.repository';
import { NearbyMastersRepository } from './nearby-masters.repository';

/**
 * Who this order may actually be offered to (issue #100).
 *
 * **Two stages, and neither ships alone.** PostGIS produces the geographic and
 * business candidate set; Redis says which of those masters is genuinely
 * reachable. `masters.is_available` is the switch a master flipped and it
 * survives a restart, a flat battery and Android killing the process; the
 * presence key is whether the server has heard from that app inside the TTL.
 * A query that trusted only the column would offer work to a switched-off
 * handset and the order would sit unaccepted until the dispatch window expired
 * (`docs/architecture/database-architecture.md` § The nearby-masters query).
 *
 * **This has no authorization of its own, and it is not an endpoint.** It is
 * called by dispatch. Exposing it over HTTP would hand every master's position
 * to whoever asked — location is PII and a master's live position is visible
 * only to the customer on an active order (CLAUDE.md §11).
 *
 * Ordering is distance and nothing else. The weighted model on rating,
 * response rate and completion rate is deliberately out of scope for EPIC 7
 * ([ADR-0009](docs/decisions/ADR-0009-dispatch-model.md)) — it would be tuned
 * against no data.
 */
@Injectable()
export class NearbyMastersService {
  constructor(
    private readonly repository: NearbyMastersRepository,
    private readonly presence: MasterPresenceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Eligible masters for one dispatch round, nearest first.
   *
   * **A Redis failure comes out of here as a thrown error.** There is no
   * `catch`, and that is the design: both silent answers are wrong in a way
   * nothing downstream could detect. Treating an outage as "nobody is online"
   * would fabricate a `NO_MASTER_FOUND` for an order a dozen masters could
   * have taken; treating it as "everybody is online" would broadcast to phones
   * nobody can reach. `MasterPresenceService.remainingSecondsOrOffline` exists
   * for the read that shows a master their own state and its doc comment says
   * why dispatch must not use it.
   *
   * Presence is applied **after** the Postgres stage rather than injected into
   * the SQL as an id array, because the live set is only knowable by asking
   * about specific masters: `filterLive` is one `MGET` over the candidate
   * keys, and the candidate list is bounded by
   * `DISPATCH_MAX_MASTERS_PER_BROADCAST * CANDIDATE_OVERFETCH_FACTOR`. The
   * alternative — enumerating every live master in the city from Redis and
   * passing the array down — is bounded by the whole fleet rather than by one
   * broadcast.
   *
   * Filtering afterwards means the `LIMIT` lands **before** liveness is known,
   * so the repository over-fetches (`CANDIDATE_OVERFETCH_FACTOR`) and the cap
   * is applied here, to live masters. Taking the cap from Postgres and
   * filtering it down would let dark masters consume broadcast slots, and
   * widening the radius does not rescue that: the next round returns the same
   * dark ids — they are still the nearest — plus farther masters that sort
   * after them and are cut by the same `LIMIT`. With the twenty nearest dark,
   * every round would broadcast to nobody while live masters sat just outside.
   *
   * The residual cost, stated rather than hidden: the result is still smaller
   * than the cap when **more** than the over-fetch can absorb has gone dark.
   * That is a real fleet-wide outage rather than the ordinary case, and a
   * short broadcast is the correct answer to it.
   *
   * With no candidates at all, no Redis call is made and the answer is the
   * empty list. That is not "nobody is online" standing in for an outage:
   * Postgres found nobody in range, which is an answer liveness cannot change.
   */
  async findEligible(query: NearbyMastersQuery): Promise<NearbyMasterCandidate[]> {
    const candidates = await this.repository.findCandidates(query);
    const live = await this.presence.filterLive(candidates.map((row) => row.masterId));
    return candidates
      .filter((row) => live.has(row.masterId))
      .slice(0, this.config.dispatch.maxMastersPerBroadcast);
  }

  /**
   * Whether one named master is eligible for one order **right now** — the
   * accept path's re-check (issue #101).
   *
   * Both stages again, in the same order and with the same failure behaviour:
   * Postgres answers verification, intent, the service offer, the radius and
   * the debt gate; Redis answers liveness, and a Redis failure comes out of
   * here as a thrown error rather than as "not live". Refusing an accept
   * because Redis blinked would be wrong, but so would allowing one, and only
   * one of those is visible afterwards — which is why neither is guessed at.
   *
   * **It is not `findEligible(...).some(...)`.** That list is truncated to
   * `DISPATCH_MAX_MASTERS_PER_BROADCAST` nearest, so the twenty-first-nearest
   * master — who was legitimately offered the job by an earlier, narrower
   * round, or by a round in which somebody closer has since gone dark — would
   * be refused for being far away rather than for being ineligible. The
   * question here is about one master, so it is asked about one master.
   */
  async isEligible(masterId: string, query: NearbyMastersQuery): Promise<boolean> {
    if (!(await this.repository.isEligible(masterId, query))) {
      return false;
    }
    const live = await this.presence.filterLive([masterId]);
    return live.has(masterId);
  }
}
