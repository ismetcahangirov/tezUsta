import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lte, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type {
  MasterDocumentRow,
  MasterDocumentTypeName,
  MasterVerificationHistoryRow,
} from '../../infra/database/schema/master-verification';
import {
  masterDocuments,
  masterVerificationHistory,
} from '../../infra/database/schema/master-verification';
import type { MasterVerificationStatusName } from '../../infra/database/schema/masters';
import { masters } from '../../infra/database/schema/masters';

/**
 * Who is making a verification transition.
 *
 * A discriminated union rather than two optional ids, because exactly one of
 * them is right for each kind and the database says so too
 * (`master_verification_history_actor_shape`). Passing both, or neither, is
 * not a state this type can express — which is the only way to be sure the
 * CHECK never fires in production.
 */
export type VerificationActor =
  | { readonly kind: 'master'; readonly userId: string }
  | { readonly kind: 'admin'; readonly adminUserId: string };

function actorColumns(
  actor: VerificationActor,
): { actorKind: 'master'; actorUserId: string } | { actorKind: 'admin'; actorAdminId: string } {
  return actor.kind === 'master'
    ? { actorKind: 'master', actorUserId: actor.userId }
    : { actorKind: 'admin', actorAdminId: actor.adminUserId };
}

/** What a winning confirm produced, and which objects it orphaned. */
export interface ConfirmedUpload {
  readonly row: MasterDocumentRow;
  readonly supersededStorageKeys: readonly string[];
}

/**
 * Internal signal that another confirm won the race, used to roll the
 * transaction back without leaving the supersede committed.
 *
 * Never escapes the repository: `confirmUpload` catches it and returns
 * `undefined`, because "you lost a race" is a repository fact and the HTTP
 * answer to it is the service's decision.
 */
class ConfirmRaceLostError extends Error {
  constructor() {
    super('Another request confirmed this upload first.');
    this.name = 'ConfirmRaceLostError';
    Object.setPrototypeOf(this, ConfirmRaceLostError.prototype);
  }
}

/**
 * Drizzle queries over `master_documents` and `master_verification_history`.
 *
 * Two rules shape everything here. **A document is always addressed by master
 * id as well as by its own id**, so a query cannot accidentally return another
 * master's identity document even if a service above forgets to check — the
 * ownership rule is in the WHERE clause, not only in the caller. And **history
 * is only ever inserted**: a trigger installed by
 * `0008_master_verification.sql` raises on UPDATE and DELETE, so there is no
 * method here that could attempt one.
 */
@Injectable()
export class MasterVerificationRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * The abandoned presign for this document type, if there is one.
   *
   * A row in `awaiting_upload` holds a key that was issued and never
   * confirmed. The partial unique index allows exactly one per type, so
   * re-presigning has to clear it first.
   */
  async findPendingUpload(
    masterId: string,
    documentType: MasterDocumentTypeName,
  ): Promise<MasterDocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masterDocuments)
      .where(
        and(
          eq(masterDocuments.masterId, masterId),
          eq(masterDocuments.documentType, documentType),
          eq(masterDocuments.status, 'awaiting_upload'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Discards an abandoned presign.
   *
   * A hard delete, and the only one in this module. Nothing is being
   * destroyed: the row records that a URL was minted, not that anything
   * happened, and the caller deletes the object alongside it. Superseding
   * instead would leave a row that permanently occupies the "one outstanding
   * presign" slot, so a master who backgrounded the app mid-upload could never
   * try again.
   */
  async deletePendingUpload(id: string): Promise<void> {
    await this.db
      .delete(masterDocuments)
      .where(and(eq(masterDocuments.id, id), eq(masterDocuments.status, 'awaiting_upload')));
  }

  /**
   * Verification documents nobody is coming back for (#128).
   *
   * **The status is named, not inferred.** A row in `awaiting_upload` is one
   * where a URL was minted and no confirm ever arrived — and, crucially, the
   * bytes may well be sitting in the bucket regardless, because storage has
   * no idea whether we accepted them. Anything past that status has reached
   * review: `pending_review` is waiting for an admin, `accepted` and
   * `rejected` are the evidence behind a decision, and
   * `docs/product/admin-flow.md`'s "no destructive deletes" is about exactly
   * those. None of them is a candidate at any age, which is why the predicate
   * says `= 'awaiting_upload'` rather than deriving the set from a null
   * column — the rule {@link listAttachedForOrder}'s counterpart in
   * `order-photos.repository.ts` states.
   *
   * **The cutoff is the master's last document activity, not the row's own
   * age.** The `NOT EXISTS` is the whole point: a master part-way through
   * gathering the three documents ADR-0023 requires would otherwise lose the
   * first one out from under them, and that is the person the window existed
   * to be generous to. A master with any document touched inside the window
   * is left entirely alone; one who stopped loses every stale presign at
   * once.
   *
   * This is the one read in this repository not addressed by master id, and
   * it is a deliberate, documented exception: a sweep has no actor and no
   * master to scope to. Nothing identifying comes back — the caller needs the
   * id and the storage key and nothing else.
   */
  async listAbandonedUploads(
    cutoff: Date,
    limit: number,
  ): Promise<{ id: string; masterId: string }[]> {
    // Self-joined under an alias so the correlation is to THIS row's master.
    const sibling = alias(masterDocuments, 'recent_document');

    return this.db
      .select({ id: masterDocuments.id, masterId: masterDocuments.masterId })
      .from(masterDocuments)
      .where(
        and(
          eq(masterDocuments.status, 'awaiting_upload'),
          lte(masterDocuments.updatedAt, cutoff),
          // In SQL rather than filtered in the caller, and that is not a
          // style choice: filtering after `LIMIT` would let one protected
          // master's stale row sit at the head of the ordering forever and
          // starve every other candidate behind it.
          notExists(
            this.db
              .select({ present: sql`1` })
              .from(sibling)
              .where(
                and(eq(sibling.masterId, masterDocuments.masterId), gt(sibling.updatedAt, cutoff)),
              ),
          ),
        ),
      )
      .orderBy(asc(masterDocuments.updatedAt))
      .limit(limit);
  }

  /**
   * Deletes one abandoned presign, and its bytes with it. Returns `false`
   * when the row was no longer `awaiting_upload` — the master confirmed the
   * upload between the listing above and this call, and their document must
   * survive.
   *
   * **The ordering is `OrderPhotosRepository.deleteAbandoned`'s, for its
   * reasons**, and those reasons are worth repeating rather than
   * cross-referencing, because the wrong order is the plausible one here:
   * `presignUpload` deletes the row and then the object, correctly, since a
   * replacement presign is about to be minted either way. A sweep cannot copy
   * that — the one time the storage call fails, the row is gone and the bytes
   * are orphaned forever, which is the problem this sweep exists to solve.
   *
   * So: conditional DELETE first, inside a transaction, then the object while
   * the row is held. The transaction is not making the two move together — it
   * cannot — it is taking the lock, so a confirm racing the sweep blocks and
   * then finds no row rather than finding one whose bytes are already gone. A
   * storage failure rolls the row back and the next run retries; a commit
   * that fails after the object is gone leaves the next run deleting a key
   * that is already absent, which `StorageProvider.delete` is specified to
   * treat as success.
   *
   * `deleteObject` is a callback rather than a `StorageProvider`, so this
   * repository keeps knowing nothing about storage.
   */
  async deleteAbandonedUpload(
    documentId: string,
    deleteObject: (storageKey: string) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(masterDocuments)
        .where(
          and(eq(masterDocuments.id, documentId), eq(masterDocuments.status, 'awaiting_upload')),
        )
        .returning({ storageKey: masterDocuments.storageKey });

      if (row === undefined) {
        return false;
      }

      await deleteObject(row.storageKey);
      return true;
    });
  }

  async createPendingUpload(input: {
    masterId: string;
    documentType: MasterDocumentTypeName;
    storageKey: string;
    declaredContentType: string;
    presignExpiresAt: Date;
  }): Promise<MasterDocumentRow> {
    const [row] = await this.db
      .insert(masterDocuments)
      .values({ id: uuidV7(), ...input })
      .returning();
    if (row === undefined) {
      throw new Error('Insert of master_documents returned no row.');
    }
    return row;
  }

  /** Scoped by master id as well as document id — see the class comment. */
  async findOwnDocument(
    masterId: string,
    documentId: string,
  ): Promise<MasterDocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masterDocuments)
      .where(and(eq(masterDocuments.id, documentId), eq(masterDocuments.masterId, masterId)))
      .limit(1);
    return row;
  }

  /** The live documents — superseded ones are history, not the current set. */
  async listLiveDocuments(masterId: string): Promise<MasterDocumentRow[]> {
    return this.db
      .select()
      .from(masterDocuments)
      .where(and(eq(masterDocuments.masterId, masterId), isNull(masterDocuments.supersededAt)))
      .orderBy(asc(masterDocuments.documentType));
  }

  /**
   * Turns an uploaded object into evidence, superseding whatever it replaces —
   * in one transaction.
   *
   * The two writes cannot be separate statements. Between them, the master
   * would either hold two live documents of one type (the partial unique index
   * refuses, so the confirm fails after storage already has the bytes) or
   * none at all, and an admin reviewing at that instant would see a master who
   * had lost a document they never withdrew.
   *
   * Returns `undefined` when the row was no longer `awaiting_upload` — which
   * is what makes the presigned URL single-use. S3 offers no such guarantee
   * (AWS documents that a presigned URL "can be used multiple times, up to the
   * expiration"), so this conditional transition is the mechanism: two
   * concurrent confirms both try it, and exactly one wins.
   */
  async confirmUpload(input: {
    masterId: string;
    documentId: string;
    documentType: MasterDocumentTypeName;
    sizeBytes: number;
    verifiedContentType: string;
    now: Date;
  }): Promise<ConfirmedUpload | undefined> {
    try {
      return await this.db.transaction(async (tx) => {
        // The supersede has to run FIRST, even though the confirm is the
        // statement that might lose. `master_documents_live_unique` is a plain
        // unique index, so Postgres checks it at the end of each statement
        // rather than at commit; promoting the new row while the old one is
        // still live would violate it and surface a constraint error instead
        // of the orderly replacement this is.
        const superseded = await tx
          .update(masterDocuments)
          .set({ supersededAt: input.now })
          .where(
            and(
              eq(masterDocuments.masterId, input.masterId),
              eq(masterDocuments.documentType, input.documentType),
              isNull(masterDocuments.supersededAt),
              inArray(masterDocuments.status, ['pending_review', 'accepted', 'rejected']),
            ),
          )
          .returning({ storageKey: masterDocuments.storageKey, status: masterDocuments.status });

        const [row] = await tx
          .update(masterDocuments)
          .set({
            status: 'pending_review',
            sizeBytes: input.sizeBytes,
            verifiedContentType: input.verifiedContentType,
            submittedAt: input.now,
          })
          .where(
            and(
              eq(masterDocuments.id, input.documentId),
              eq(masterDocuments.masterId, input.masterId),
              eq(masterDocuments.status, 'awaiting_upload'),
            ),
          )
          .returning();

        if (row === undefined) {
          // Somebody else confirmed first. Unwind the supersede with it —
          // otherwise a losing confirm would have retired a document the
          // winner never replaced, and the master would silently be one
          // document short.
          throw new ConfirmRaceLostError();
        }

        return {
          row,
          // Only the bytes behind a document nobody ever reviewed may be
          // discarded. Evidence behind a review decision has to outlive the
          // decision, or the audit trail points at nothing (ADR-0023).
          supersededStorageKeys: superseded
            .filter((candidate) => candidate.status === 'pending_review')
            .map((candidate) => candidate.storageKey),
        };
      });
    } catch (error) {
      if (error instanceof ConfirmRaceLostError) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Records a review decision against every document that was waiting for one
   * (issue #39).
   *
   * Scoped to `pending_review` and to live rows: a document an admin already
   * accepted keeps its original reviewer and timestamp, because "who approved
   * this, and when" must not be silently rewritten by the next decision about
   * the master. A superseded one is history and is not re-judged either.
   *
   * Returns how many rows moved, which is what the audit entry records.
   */
  async reviewLiveDocuments(input: {
    masterId: string;
    toStatus: 'accepted' | 'rejected';
    adminUserId: string;
    now: Date;
  }): Promise<number> {
    const rows = await this.db
      .update(masterDocuments)
      .set({
        status: input.toStatus,
        reviewedByAdminId: input.adminUserId,
        reviewedAt: input.now,
      })
      .where(
        and(
          eq(masterDocuments.masterId, input.masterId),
          eq(masterDocuments.status, 'pending_review'),
          isNull(masterDocuments.supersededAt),
        ),
      )
      .returning({ id: masterDocuments.id });
    return rows.length;
  }

  /** The verification trail for one master, newest first. */
  async listHistory(masterId: string, limit: number): Promise<MasterVerificationHistoryRow[]> {
    return this.db
      .select()
      .from(masterVerificationHistory)
      .where(eq(masterVerificationHistory.masterId, masterId))
      .orderBy(desc(masterVerificationHistory.createdAt), desc(masterVerificationHistory.id))
      .limit(limit);
  }

  /** Withdraws a live document. Never a delete — see `confirmUpload`. */
  async supersedeDocument(masterId: string, documentId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(masterDocuments)
      .set({ supersededAt: now })
      .where(
        and(
          eq(masterDocuments.id, documentId),
          eq(masterDocuments.masterId, masterId),
          isNull(masterDocuments.supersededAt),
        ),
      )
      .returning({ id: masterDocuments.id });
    return rows.length > 0;
  }

  /**
   * Moves a master to a new verification status **and records why**, in one
   * transaction.
   *
   * The status change and its history row are the same fact. A status that
   * moved with no corresponding row is a trust decision with no record of who
   * made it, which `docs/product/admin-flow.md` says is indistinguishable from
   * an attacker's — so they commit together or not at all.
   *
   * The `from` status is in the WHERE clause rather than read first: two
   * requests racing to move the same master both read the same current status,
   * and the loser would otherwise write a history row describing a transition
   * that never happened. Returns `undefined` when the master was not in the
   * expected status any more.
   */
  async transitionStatus(input: {
    masterId: string;
    from: MasterVerificationStatusName;
    to: MasterVerificationStatusName;
    actor: VerificationActor;
    reason?: string | undefined;
    now: Date;
  }): Promise<MasterVerificationStatusName | undefined> {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(masters)
        .set({
          verificationStatus: input.to,
          // The CHECK on `masters` ties this to the status in both
          // directions, so it is set here rather than left to the caller.
          suspendedAt: input.to === 'suspended' ? input.now : null,
        })
        .where(
          and(
            eq(masters.id, input.masterId),
            eq(masters.verificationStatus, input.from),
            isNull(masters.deletedAt),
          ),
        )
        .returning({ status: masters.verificationStatus });

      if (updated === undefined) {
        return undefined;
      }

      await tx.insert(masterVerificationHistory).values({
        id: uuidV7(),
        masterId: input.masterId,
        fromStatus: input.from,
        toStatus: input.to,
        ...actorColumns(input.actor),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });

      return updated.status;
    });
  }
}
