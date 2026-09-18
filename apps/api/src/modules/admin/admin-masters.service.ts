import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { MasterDocumentRow } from '../../infra/database/schema/master-verification';
import type { MasterRow, MasterVerificationStatusName } from '../../infra/database/schema/masters';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { SessionsService } from '../auth/sessions.service';
import { MasterVerificationService } from '../masters/master-verification.service';
import { MastersService } from '../masters/masters.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type {
  AdminMasterDetail,
  AdminMasterSummary,
  AdminVerificationEvent,
} from './admin-masters.types';

/** How many history rows the detail view carries. */
const HISTORY_PAGE_SIZE = 50;

/**
 * The transition is not one this master can make from where they are.
 *
 * The current status is in `details` because an admin panel showing a stale
 * list needs to explain itself — "somebody else already verified this master"
 * is actionable; "conflict" is not.
 */
export class IllegalVerificationTransitionError extends AppError {
  constructor(from: MasterVerificationStatusName, to: MasterVerificationStatusName) {
    super(ERROR_CODES.CONFLICT, `A master who is ${from} cannot be moved to ${to}.`, 409, {
      from,
      to,
    });
    this.name = 'IllegalVerificationTransitionError';
    Object.setPrototypeOf(this, IllegalVerificationTransitionError.prototype);
  }
}

/**
 * Which statuses each admin action may be taken from.
 *
 * A table, in one place, rather than a condition scattered through five
 * methods — the same reasoning
 * `docs/architecture/backend-architecture.md` gives for the order state
 * machine. Two entries deserve their reasons written down:
 *
 * - **`verify` is reachable from `rejected`.** ADR-0023 says rejection is not
 *   a resubmission path *for the master*, and it is not; but an admin has to
 *   be able to undo an admin's mistake, and refusing that would make a
 *   mis-click permanent for someone's livelihood. It is a different actor
 *   doing a different thing.
 * - **`suspend` is reachable from everything except `suspended`.** A master
 *   under review who turns out to be a problem is suspended immediately; there
 *   is no state in which the platform must first finish reviewing somebody
 *   before it is allowed to stop them.
 */
const ALLOWED_FROM: Readonly<
  Record<AdminVerificationAction, readonly MasterVerificationStatusName[]>
> = Object.freeze({
  verify: ['pending_verification', 'changes_requested', 'rejected'],
  reject: ['pending_verification', 'changes_requested'],
  request_more: ['pending_verification', 'changes_requested'],
  suspend: ['pending_verification', 'changes_requested', 'rejected', 'active'],
  reinstate: ['suspended'],
});

const RESULTING_STATUS: Readonly<Record<AdminVerificationAction, MasterVerificationStatusName>> =
  Object.freeze({
    verify: 'active',
    reject: 'rejected',
    request_more: 'changes_requested',
    suspend: 'suspended',
    reinstate: 'active',
  });

export type AdminVerificationAction =
  'verify' | 'reject' | 'request_more' | 'suspend' | 'reinstate';

/**
 * Admin review of master verification (issue #39).
 *
 * Three rules hold for every method here, and they are the reason the module
 * exists rather than a few extra handlers on `MastersController`:
 *
 * 1. **Every action is audited** — actor, action, target, reason, timestamp —
 *    *including reads of personal data*, because a read is an action
 *    (`docs/product/admin-flow.md`). Opening a master's file and downloading
 *    their ID card are both audited, not just the decisions.
 * 2. **Every status change writes `master_verification_history`** in the same
 *    transaction as the change, so a status that moved without a record is not
 *    a state the database can be left in.
 * 3. **The status is the authority, re-read from the database.** Nothing here
 *    trusts a token claim, and nothing downstream is expected to: the check
 *    that stops a suspended master accepting work re-reads this table at the
 *    moment of the accept (`MastersService.assertCanAcceptWork`).
 */
@Injectable()
export class AdminMastersService {
  constructor(
    private readonly masters: MastersService,
    private readonly verification: MasterVerificationService,
    private readonly admins: AdminRepository,
    private readonly sessions: SessionsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The review queue.
   *
   * Deliberately **not** audited. A list of masters filtered by status carries
   * no personal data beyond a display name an admin is employed to look at,
   * and auditing every page of every list would bury the reads that matter —
   * opening one person's file, opening their ID card — under noise. The
   * boundary is the same one admin-flow.md draws: a read of *personal data* is
   * an action.
   */
  async list(input: {
    status?: MasterVerificationStatusName | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<{ items: AdminMasterSummary[]; nextCursor: string | null }> {
    // One more than asked for, to learn whether another page exists without a
    // second COUNT query over a table that only grows.
    const rows = await this.masters.listForModeration({ ...input, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const nextCursor = rows.length > input.limit ? (page.at(-1)?.id ?? null) : null;
    return { items: page.map(toSummary), nextCursor };
  }

  /**
   * One master's file: profile, live documents, and the full verification
   * trail.
   *
   * **Audited**, because this is where an admin reads a person's evidence.
   */
  async getDetail(admin: AdminActor, masterId: string): Promise<AdminMasterDetail> {
    const master = await this.requireMaster(masterId);

    const [documents, history] = await Promise.all([
      this.verification.listDocumentsForModeration(master.id),
      this.verification.listHistoryForModeration(master.id, HISTORY_PAGE_SIZE),
    ]);

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'master.read',
      targetType: 'master',
      targetId: master.id,
    });

    return {
      ...toSummary(master),
      bio: master.bio,
      documents: documents.map(toAdminDocument),
      history: history.map((row): AdminVerificationEvent => ({
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        actorKind: row.actorKind,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * A short-lived read URL for one of this master's documents.
   *
   * **Audited against the document, not the master**, so the trail answers
   * "who looked at this identity document" rather than only "who opened this
   * file". These are the most sensitive bytes TezUsta holds; an unlogged read
   * of one is the thing admin-flow.md's "a read is an action" exists for.
   */
  async presignDocument(
    admin: AdminActor,
    masterId: string,
    documentId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const master = await this.requireMaster(masterId);
    const document = await this.verification.findDocumentForModeration(master.id, documentId);

    if (document === undefined || document.status === 'awaiting_upload') {
      // Nothing is behind an unconfirmed key, and a document id that belongs
      // to a different master is not this master's business either. Both are
      // 404, for the same reason they are on the master's own routes.
      throw new NotFoundError();
    }

    const presigned = await this.storage.presignDownload({
      key: document.storageKey,
      ttlSeconds: this.config.storage.downloadTtlSeconds,
    });

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'master.document.read',
      targetType: 'master_document',
      targetId: document.id,
    });

    return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
  }

  /**
   * Every review decision, through one path.
   *
   * The order of operations is the design:
   *
   * 1. Read the master and check the transition against {@link ALLOWED_FROM}.
   * 2. Move the status **and** write the history row, in one transaction,
   *    conditioned on the status not having changed underneath — so two admins
   *    acting at once produce one decision and one record, not two records of
   *    which one is fiction.
   * 3. Only then the side effects: document review stamps, session revocation,
   *    and the audit entry.
   *
   * The audit entry is written **last and outside** the transaction. If it
   * failed inside, it would roll back a decision that was correctly made; if
   * it is written first, it describes something that may not happen. Last is
   * the order where the only failure mode is a decision that took effect and
   * whose audit write then errored — which is loud, in the logs, and
   * recoverable, rather than silent.
   */
  async act(
    admin: AdminActor,
    masterId: string,
    action: AdminVerificationAction,
    reason?: string,
  ): Promise<AdminMasterSummary> {
    const master = await this.requireMaster(masterId);
    const to = RESULTING_STATUS[action];
    const from = master.verificationStatus;

    if (!ALLOWED_FROM[action].includes(from)) {
      throw new IllegalVerificationTransitionError(from, to);
    }

    const now = new Date();

    if (from !== to) {
      const moved = await this.verification.transitionByAdmin({
        masterId: master.id,
        from,
        to,
        adminUserId: admin.adminUserId,
        reason,
        now,
      });
      if (moved === undefined) {
        // Somebody else moved this master between the read and the write.
        // Their decision is the newer one; this one is reported as a conflict
        // rather than applied on top of a status it was never checked against.
        throw new IllegalVerificationTransitionError(from, to);
      }
    }
    // `from === to` is reachable for exactly one action: asking a master for
    // more information when they are already `changes_requested`, because the
    // admin wants something different this time. There is no transition, so
    // there is no history row — `master_verification_history` refuses one from
    // a status to itself, and rightly: a record of "nothing changed" would
    // dilute the trail of what did. The request is still recorded, in the
    // audit log, which is where an action that changed no state belongs.

    if (action === 'verify' || action === 'reject') {
      await this.verification.reviewDocumentsForModeration({
        masterId: master.id,
        toStatus: action === 'verify' ? 'accepted' : 'rejected',
        adminUserId: admin.adminUserId,
        now,
      });
    }

    if (action === 'suspend') {
      // ADR-0014's revocation table: suspension by an admin revokes every
      // session. Belt to the guard's braces — the accept check re-reads
      // `verification_status` anyway, so suspension bites immediately — but
      // this is what stops the master's refresh token from quietly minting a
      // new access token for the next thirty days.
      await this.sessions.revokeAllForSuspension(master.userId, now);
    }

    await this.admins.appendAudit(
      {
        adminUserId: admin.adminUserId,
        action: `master.${action.replace('_', '.')}`,
        targetType: 'master',
        targetId: master.id,
        reason,
      },
      now,
    );

    // Re-read rather than reconstruct. Assembling the response from the row we
    // started with plus the values we believe we wrote is one future column —
    // or one trigger — away from reporting something that is not in the
    // database. This is an admin action taken a few times a day, and a second
    // indexed lookup is a cheap price for the response being the row.
    return toSummary(await this.requireMaster(master.id));
  }

  private async requireMaster(masterId: string): Promise<MasterRow> {
    const row = await this.masters.findForModeration(masterId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }
}

function toSummary(row: MasterRow): AdminMasterSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    verificationStatus: row.verificationStatus,
    suspendedAt: row.suspendedAt === null ? null : row.suspendedAt.toISOString(),
    isAvailable: row.isAvailable,
    ratingCount: row.ratingCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * What an admin sees of a document.
 *
 * Carries `verifiedContentType` and `sizeBytes`, which the master's own view
 * deliberately does not: a reviewer deciding whether to trust a file has a
 * legitimate reason to know what the server concluded it was. The storage key
 * still does not appear — it is a capability, and the download endpoint is how
 * an admin opens the file.
 */
function toAdminDocument(row: MasterDocumentRow): AdminMasterDetail['documents'][number] {
  return {
    id: row.id,
    documentType: row.documentType,
    status: row.status,
    sizeBytes: row.sizeBytes,
    verifiedContentType: row.verifiedContentType,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
  };
}
