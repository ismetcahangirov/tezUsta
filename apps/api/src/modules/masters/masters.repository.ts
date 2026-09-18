import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type {
  MasterRow,
  MasterServiceRow,
  MasterVerificationStatusName,
} from '../../infra/database/schema/masters';
import { masters, masterServices } from '../../infra/database/schema/masters';
import type { ServiceRow } from '../../infra/database/schema/services';
import { services } from '../../infra/database/schema/services';
import { UsersRepository } from '../users/users.repository';

/** Whether {@link MastersRepository.createOrRevive} inserted a new row. */
export interface CreateOrReviveResult {
  readonly master: MasterRow;
  readonly created: boolean;
}

/**
 * Drizzle queries over `masters` and `master_services`, and nothing else — no
 * business rules, no HTTP (`docs/architecture/backend-architecture.md`
 * § Module rules).
 *
 * Every read of `masters` filters `deleted_at IS NULL`. A soft-deleted profile
 * must behave as absent to every caller, and leaving that filter to each call
 * site is how a deleted profile eventually answers a request.
 *
 * `master_services` has no `deleted_at` of its own: the row belongs to a
 * master, so a deleted master's offers are unreachable through every method
 * here, each of which starts from a live master id.
 */
@Injectable()
export class MastersRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly users: UsersRepository,
  ) {}

  /**
   * Creates the caller's master profile, or brings back the one they
   * soft-deleted, and grants the `master` role — all in one transaction.
   *
   * The same construction `CustomersRepository.createOrRevive` uses, and for
   * the same reason: the unique index on `user_id` is what makes "exactly one
   * master profile per account" true, and a read-then-insert would let two
   * retries of the same POST both read "no profile" and both insert, turning a
   * flaky connection into a 500.
   *
   * **The revive deliberately does not reset `verification_status`.** A master
   * who deletes their profile and comes back is the same person the admin
   * already reviewed, and re-sending a verified master to the back of the
   * queue would make deletion a way to lose standing. It equally means a
   * `rejected` master cannot launder the decision by deleting and
   * re-registering, which is the failure that actually matters.
   */
  async createOrRevive(input: {
    userId: string;
    displayName: string;
    bio?: string | undefined;
  }): Promise<CreateOrReviveResult> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(masters)
        .values({
          id: uuidV7(),
          userId: input.userId,
          displayName: input.displayName,
          ...(input.bio === undefined ? {} : { bio: input.bio }),
        })
        .onConflictDoNothing()
        .returning();

      if (inserted !== undefined) {
        await this.users.grantRole(input.userId, 'master', tx);
        return { master: inserted, created: true };
      }

      const [revived] = await tx
        .update(masters)
        .set({
          displayName: input.displayName,
          ...(input.bio === undefined ? {} : { bio: input.bio }),
          deletedAt: null,
        })
        .where(eq(masters.userId, input.userId))
        .returning();

      if (revived === undefined) {
        // Unreachable: the INSERT conflicted, so the row exists, and nothing
        // deletes from this table. Present so the narrowing is explicit
        // rather than an assertion.
        throw new Error('Master row vanished between conflict and update.');
      }

      await this.users.grantRole(input.userId, 'master', tx);
      return { master: revived, created: false };
    });
  }

  async findByUserId(userId: string): Promise<MasterRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masters)
      .where(and(eq(masters.userId, userId), isNull(masters.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * By profile id, for the ownership-checked read. Returns the row without
   * judging who may see it — that decision belongs to the service, where
   * `requireVisibleOrNotFound` makes "does not exist" and "not yours" one
   * answer.
   */
  async findById(id: string): Promise<MasterRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masters)
      .where(and(eq(masters.id, id), isNull(masters.deletedAt)))
      .limit(1);
    return row;
  }

  async updateByUserId(
    userId: string,
    patch: { displayName?: string | undefined; bio?: string | null | undefined },
  ): Promise<MasterRow | undefined> {
    const [row] = await this.db
      .update(masters)
      .set(patch)
      .where(and(eq(masters.userId, userId), isNull(masters.deletedAt)))
      .returning();
    return row;
  }

  /**
   * The catalogue row a master is trying to offer, read straight from
   * `services` rather than through `ServicesService`.
   *
   * This is the one place the module reaches past its own tables, and it does
   * so for a single boolean and a pricing kind. Going through the catalogue
   * module's paginated, locale-resolving read would drag a `LocalizedText`
   * projection and a cursor into a question that is "does this id name an
   * active service, and how is it priced?".
   */
  async findCatalogueService(serviceId: string): Promise<ServiceRow | undefined> {
    const [row] = await this.db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    return row;
  }

  /**
   * Ordered by `service_id` so a client sees a stable list across requests.
   * The rows are few — a master offers a handful of services, not thousands —
   * so this is deliberately unpaginated.
   */
  async listServices(masterId: string): Promise<MasterServiceRow[]> {
    return this.db
      .select()
      .from(masterServices)
      .where(eq(masterServices.masterId, masterId))
      .orderBy(asc(masterServices.serviceId));
  }

  async findService(masterId: string, serviceId: string): Promise<MasterServiceRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masterServices)
      .where(and(eq(masterServices.masterId, masterId), eq(masterServices.serviceId, serviceId)))
      .limit(1);
    return row;
  }

  /**
   * Adds an offer. Returns `undefined` when the master already offers this
   * service, which the composite primary key decides rather than a prior read:
   * two concurrent adds of the same pair would both pass a check-then-insert,
   * and the loser would surface a constraint violation as a 500.
   */
  async addService(input: {
    masterId: string;
    serviceId: string;
    priceMinor: number | null;
    isActive: boolean;
  }): Promise<MasterServiceRow | undefined> {
    const [row] = await this.db
      .insert(masterServices)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  async updateService(
    masterId: string,
    serviceId: string,
    patch: { priceMinor?: number | null | undefined; isActive?: boolean | undefined },
  ): Promise<MasterServiceRow | undefined> {
    const [row] = await this.db
      .update(masterServices)
      .set(patch)
      .where(and(eq(masterServices.masterId, masterId), eq(masterServices.serviceId, serviceId)))
      .returning();
    return row;
  }

  /** Returns false when there was nothing to remove — the service turns that into a 404. */
  async removeService(masterId: string, serviceId: string): Promise<boolean> {
    const removed = await this.db
      .delete(masterServices)
      .where(and(eq(masterServices.masterId, masterId), eq(masterServices.serviceId, serviceId)))
      .returning({ serviceId: masterServices.serviceId });
    return removed.length > 0;
  }

  /**
   * The admin review queue (issue #39).
   *
   * Ordered by id descending, which is newest-first because ids are UUIDv7 and
   * therefore time-ordered — no second sort column, and no `created_at` index
   * that would only ever agree with the primary key. The cursor is the last id
   * of the previous page, so paging is a range scan rather than an OFFSET the
   * planner has to count past.
   *
   * Soft-deleted masters are excluded. A deleted profile is not in a review
   * queue, and an admin acting on one would be acting on nothing.
   */
  async listForReview(input: {
    status?: MasterVerificationStatusName | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<MasterRow[]> {
    const conditions = [isNull(masters.deletedAt)];
    if (input.status !== undefined) {
      conditions.push(eq(masters.verificationStatus, input.status));
    }
    if (input.cursor !== undefined) {
      conditions.push(lt(masters.id, input.cursor));
    }

    return this.db
      .select()
      .from(masters)
      .where(and(...conditions))
      .orderBy(desc(masters.id))
      .limit(input.limit);
  }

  /**
   * Soft delete. Returns false when there was no live profile to delete, which
   * the service turns into the same 404 a stranger's id gets.
   *
   * `isNull(deletedAt)` in the WHERE is not redundant with the `set`: without
   * it, deleting twice would keep moving `deleted_at` forward, and the second
   * call would report success for work it did not do.
   */
  async softDeleteByUserId(userId: string): Promise<boolean> {
    const deleted = await this.db
      .update(masters)
      // Going offline is part of deleting: a soft-deleted profile that still
      // says `is_available` would be a master dispatch believes is waiting for
      // work. The Redis liveness half expires on its own (issue #40).
      .set({ deletedAt: new Date(), isAvailable: false })
      .where(and(eq(masters.userId, userId), isNull(masters.deletedAt)))
      .returning({ id: masters.id });
    return deleted.length > 0;
  }
}
