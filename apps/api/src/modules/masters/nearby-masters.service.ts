import { Injectable } from '@nestjs/common';

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
   * keys, and the candidate list is already capped at
   * `DISPATCH_MAX_MASTERS_PER_BROADCAST`. The alternative — enumerating every
   * live master in the city from Redis and passing the array down — is bounded
   * by the whole fleet rather than by one broadcast.
   *
   * The cost of that order is honest and worth stating: the result can be
   * **smaller** than the broadcast cap when a master inside the nearest N has
   * gone dark. It is a narrow band in practice — a position report refreshes
   * presence in the same request, so the freshness bound the SQL already
   * applies is the same window liveness expires on — and the dispatch round
   * widens the radius anyway. It is never wrong, only occasionally smaller.
   *
   * With no candidates at all, no Redis call is made and the answer is the
   * empty list. That is not "nobody is online" standing in for an outage:
   * Postgres found nobody in range, which is an answer liveness cannot change.
   */
  async findEligible(query: NearbyMastersQuery): Promise<NearbyMasterCandidate[]> {
    const candidates = await this.repository.findCandidates(query);
    const live = await this.presence.filterLive(candidates.map((row) => row.masterId));
    return candidates.filter((row) => live.has(row.masterId));
  }
}
