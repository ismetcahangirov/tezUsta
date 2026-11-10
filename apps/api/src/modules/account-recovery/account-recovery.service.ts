import { createHash, createHmac, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AccountRecoveryStatus,
  AccountRecoverySubject,
  AdminAccountRecovery,
  AdminAccountRecoveryEmails,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { isUniqueViolation } from '../../infra/database/database-error';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { AccountRecoveryRow } from '../../infra/database/schema/account-recovery';
import { maskEmail } from '../../infra/email/email-address';
import type { EmailSender } from '../../infra/email/email-sender.types';
import { EMAIL_SENDER } from '../../infra/email/email-sender.types';
import { RateLimiterService } from '../../infra/rate-limit/rate-limiter.service';
import { AdminRepository } from '../admin/admin.repository';
import type { AdminActor } from '../admin/admin.types';
import { InsufficientAdminPermissionError } from '../admin/admin-permission.guard';
import type { AccountEmailMoveResult } from '../auth/account-email-mover';
import { AccountEmailMover } from '../auth/account-email-mover';
import { EmailAddressTakenError, EmailChangeSameAddressError } from '../auth/email-change.service';
import { generateOtpCode } from '../auth/otp-code';
import type { OtpConfig } from '../auth/otp.config';
import { OtpService } from '../auth/otp.service';
import { OTP_CONFIG } from '../auth/otp.tokens';
import {
  renderRecoveryCancelledNotice,
  renderRecoveryCodeEmail,
  renderRecoveryMovedNotice,
  renderRecoveryOpenedNotice,
} from './account-recovery-emails';
import type { AccountRecoveryView } from './account-recovery.repository';
import { AccountRecoveryRepository } from './account-recovery.repository';

/** ADR-0074 § 2: the move waits 72 hours after the evidence is accepted, for both roles. */
export const RECOVERY_HOLD_MS = 72 * 60 * 60 * 1000;

/** The audit log's `target_type` for every row this service writes. */
export const RECOVERY_AUDIT_TARGET = 'account_recovery';

/** The Redis scope of the per-request attempt cap on the new address's code. */
const ATTEMPT_SCOPE = 'account-recovery-verify';

/** The most open requests the queue returns. Recovery is rare (ADR-0074 "Revisit when"). */
const OPEN_LIST_LIMIT = 200;

export class AccountRecoveryAlreadyOpenError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_ALREADY_OPEN,
      'This account already has an open recovery.',
      409,
    );
    this.name = 'AccountRecoveryAlreadyOpenError';
    Object.setPrototypeOf(this, AccountRecoveryAlreadyOpenError.prototype);
  }
}

export class AccountRecoveryChangePendingError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_CHANGE_PENDING,
      'The user has a change of address pending.',
      409,
    );
    this.name = 'AccountRecoveryChangePendingError';
    Object.setPrototypeOf(this, AccountRecoveryChangePendingError.prototype);
  }
}

export class AccountRecoveryAccountInactiveError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_ACCOUNT_INACTIVE,
      'The account is suspended or deleted.',
      409,
    );
    this.name = 'AccountRecoveryAccountInactiveError';
    Object.setPrototypeOf(this, AccountRecoveryAccountInactiveError.prototype);
  }
}

export class AccountRecoveryCodeInvalidError extends AppError {
  constructor() {
    super(ERROR_CODES.ACCOUNT_RECOVERY_CODE_INVALID, 'The code is invalid or has expired.', 422);
    this.name = 'AccountRecoveryCodeInvalidError';
    Object.setPrototypeOf(this, AccountRecoveryCodeInvalidError.prototype);
  }
}

export class AccountRecoveryNotAllowedNowError extends AppError {
  constructor(status: AccountRecoveryStatus) {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_NOT_ALLOWED_NOW,
      `The request is ${status.replace('_', ' ')}.`,
      409,
      { status },
    );
    this.name = 'AccountRecoveryNotAllowedNowError';
    Object.setPrototypeOf(this, AccountRecoveryNotAllowedNowError.prototype);
  }
}

export class AccountRecoveryHoldRunningError extends AppError {
  constructor(holdUntil: Date) {
    super(ERROR_CODES.ACCOUNT_RECOVERY_HOLD_RUNNING, 'The 72-hour hold has not ended.', 409, {
      holdUntil: holdUntil.toISOString(),
    });
    this.name = 'AccountRecoveryHoldRunningError';
    Object.setPrototypeOf(this, AccountRecoveryHoldRunningError.prototype);
  }
}

export class AccountRecoverySameAdminError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_SAME_ADMIN,
      'The admin who opened a recovery cannot approve it.',
      403,
    );
    this.name = 'AccountRecoverySameAdminError';
    Object.setPrototypeOf(this, AccountRecoverySameAdminError.prototype);
  }
}

/**
 * The cancel link is mailed to a real inbox; over plain http a network on the
 * way could read the token or rewrite the page. Checked where the link is
 * built, as `admin.config.ts` checks the setup link's base, so a production
 * process without the value fails at startup and nothing else does.
 */
export class InsecureRecoveryLinkBaseError extends Error {
  constructor() {
    super('ACCOUNT_RECOVERY_LINK_BASE_URL must be an https URL under NODE_ENV=production (#515).');
    this.name = 'InsecureRecoveryLinkBaseError';
  }
}

/** Carries a refused move out of the transaction, so the approval rolls back with it. */
class MoveRefused extends Error {
  constructor(readonly result: Exclude<AccountEmailMoveResult, 'moved'>) {
    super(`recovery move refused: ${result}`);
  }
}

export function recoveryStatus(row: AccountRecoveryRow, now: Date): AccountRecoveryStatus {
  if (row.movedAt !== null) {
    return 'moved';
  }
  if (row.cancelledAt !== null) {
    return 'cancelled';
  }
  if (row.holdUntil === null) {
    return 'awaiting_code';
  }
  return row.holdUntil.getTime() <= now.getTime() ? 'ready' : 'on_hold';
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

function toView(row: AccountRecoveryView, now: Date): AdminAccountRecovery {
  return {
    id: row.id,
    status: recoveryStatus(row, now),
    customerId: row.customerId,
    masterId: row.masterId,
    accountName: row.accountName,
    openedByName: row.openedByName,
    cancelledByName: row.cancelledByName,
    approvedByName: row.approvedByName,
    oldEmailMasked: maskEmail(row.oldEmail),
    newEmailMasked: maskEmail(row.newEmail),
    evidenceNotes: row.evidenceNotes,
    openedByAdminId: row.openedByAdminId,
    openedAt: row.createdAt.toISOString(),
    codeExpiresAt: row.codeExpiresAt.toISOString(),
    codeVerifiedAt: iso(row.codeVerifiedAt),
    holdUntil: iso(row.holdUntil),
    cancelledAt: iso(row.cancelledAt),
    cancelSource: row.cancelSource,
    cancelledByAdminId: row.cancelledByAdminId,
    cancelReason: row.cancelReason,
    approvedByAdminId: row.approvedByAdminId,
    movedAt: iso(row.movedAt),
  };
}

/** SHA-256 of a cancel token. The token is 256 random bits, so a key would add nothing. */
export function hashCancelToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface OpenRecoveryInput {
  readonly subject: AccountRecoverySubject;
  readonly newEmail: string;
  readonly evidenceNotes: string;
}

/**
 * Support-mediated recovery of an account whose sign-in address is lost
 * ([ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md)
 * §§ 2–5, #515).
 *
 * The steps, and who may take each:
 *
 * 1. **Open** (`accounts.recover`): the evidence notes, and a code to the new
 *    address. Refused while the account has another recovery open or a
 *    self-serve change pending, or is not active.
 * 2. **Verify** (`accounts.recover`): the code the user read back. The 72-hour
 *    hold starts, and the old address is told, with a link that cancels.
 * 3. **Approve** (`super_admin`, never the opener), after the hold: the move,
 *    through the same {@link AccountEmailMover} as the self-serve change, so
 *    the two paths cannot drift on what a move does.
 *
 * Either an admin or the link can cancel at any point before the move.
 *
 * Every admin step writes its audit row in the transaction that makes it. The
 * evidence bar itself is checked by a person, not by this code (ADR-0074 § 2).
 */
@Injectable()
export class AccountRecoveryService {
  private readonly logger = new Logger(AccountRecoveryService.name);

  constructor(
    private readonly recoveries: AccountRecoveryRepository,
    private readonly mover: AccountEmailMover,
    private readonly admins: AdminRepository,
    private readonly otp: OtpService,
    private readonly limiter: RateLimiterService,
    @Inject(EMAIL_SENDER) private readonly mail: EmailSender,
    @Inject(OTP_CONFIG) private readonly otpConfig: OtpConfig,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {
    if (
      config.runtime.nodeEnv === 'production' &&
      !config.email.recoveryLinkBaseUrl.startsWith('https://')
    ) {
      throw new InsecureRecoveryLinkBaseError();
    }
  }

  async listOpen(now: Date = new Date()): Promise<AdminAccountRecovery[]> {
    const rows = await this.recoveries.listOpen(OPEN_LIST_LIMIT);
    return rows.map((row) => toView(row, now));
  }

  /** One request. **Audited**: it carries the evidence notes. */
  async detail(
    admin: AdminActor,
    id: string,
    now: Date = new Date(),
  ): Promise<AdminAccountRecovery> {
    const row = await this.require(id);
    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'account.recovery.read',
      targetType: RECOVERY_AUDIT_TARGET,
      targetId: row.id,
    });
    return toView(row, now);
  }

  /** Both whole addresses, with a reason, audited as a personal-data read (ADR-0043 § 6). */
  async revealEmails(
    admin: AdminActor,
    id: string,
    reason: string,
  ): Promise<AdminAccountRecoveryEmails> {
    const row = await this.require(id);
    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'account.recovery.emails.read',
      targetType: RECOVERY_AUDIT_TARGET,
      targetId: row.id,
      reason,
    });
    return { oldEmail: row.oldEmail, newEmail: row.newEmail };
  }

  async open(
    admin: AdminActor,
    input: OpenRecoveryInput,
    now: Date = new Date(),
  ): Promise<AdminAccountRecovery> {
    const account = await this.recoveries.accountOf(input.subject.kind, input.subject.id);
    if (account === undefined) {
      throw new NotFoundError();
    }
    if (!account.active) {
      throw new AccountRecoveryAccountInactiveError();
    }
    if (input.newEmail === account.email) {
      throw new EmailChangeSameAddressError();
    }
    // Asked here, unlike the self-serve start: an admin can already find any
    // account by its address, so this tells them nothing new, and a request
    // that can never move is better refused now than after a 72-hour hold.
    if (await this.recoveries.addressTaken(input.newEmail, account.userId)) {
      throw new EmailAddressTakenError();
    }

    const id = uuidV7();
    const code = generateOtpCode(this.otpConfig.length);
    try {
      await this.db.transaction(async (tx) => {
        await this.recoveries.lockAccount(account.userId, tx);
        if (await this.recoveries.hasOpenRequest(account.userId, tx)) {
          throw new AccountRecoveryAlreadyOpenError();
        }
        if (await this.recoveries.hasLiveEmailChange(account.userId, now, tx)) {
          throw new AccountRecoveryChangePendingError();
        }
        await this.recoveries.insert(
          {
            id,
            userId: account.userId,
            oldEmail: account.email,
            newEmail: input.newEmail,
            openedByAdminId: admin.adminUserId,
            evidenceNotes: input.evidenceNotes,
            codeHash: this.hashCode(id, code),
            codeExpiresAt: new Date(now.getTime() + this.otpConfig.ttlMs),
            createdAt: now,
          },
          tx,
        );
        await this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'account.recovery.open',
            targetType: RECOVERY_AUDIT_TARGET,
            targetId: id,
            // Not the evidence notes: they can carry an ID card number, and
            // the audit log is never redacted (ADR-0043 § 6). They stay on
            // the request row, which is.
            after: { userId: account.userId, subject: input.subject.kind },
          },
          now,
          tx,
        );
      });
    } catch (error: unknown) {
      // Two admins opening at once both pass the check under their own
      // snapshot only if neither held the lock; the partial unique index is
      // the backstop either way.
      if (isUniqueViolation(error)) {
        throw new AccountRecoveryAlreadyOpenError();
      }
      throw error;
    }

    // After commit: a send the platform's budget refuses leaves a request
    // waiting for a code, which `resendCode` can send once the budget allows.
    await this.sendCode(input.newEmail, code, now);
    this.logger.log(
      `account recovery opened: request=${id} user=${account.userId} admin=${admin.adminUserId} ` +
        `to=${maskEmail(input.newEmail)}`,
    );
    return toView(await this.require(id), now);
  }

  /** A fresh code to the new address, for a request still waiting for one. Restarts the attempt budget. */
  async resendCode(
    admin: AdminActor,
    id: string,
    now: Date = new Date(),
  ): Promise<AdminAccountRecovery> {
    const row = await this.require(id);
    const code = generateOtpCode(this.otpConfig.length);
    const replaced = await this.db.transaction(async (tx) => {
      const done = await this.recoveries.replaceCode(
        id,
        this.hashCode(id, code),
        new Date(now.getTime() + this.otpConfig.ttlMs),
        tx,
      );
      if (done) {
        await this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'account.recovery.code.resend',
            targetType: RECOVERY_AUDIT_TARGET,
            targetId: id,
          },
          now,
          tx,
        );
      }
      return done;
    });
    if (!replaced) {
      throw new AccountRecoveryNotAllowedNowError(recoveryStatus(row, now));
    }
    await this.limiter.clearAttempts(ATTEMPT_SCOPE, id);
    await this.sendCode(row.newEmail, code, now);
    return toView(await this.require(id), now);
  }

  /**
   * The code the user read back from the new address. Right, it starts the
   * hold and mails the old address the cancel link.
   *
   * The attempt is counted before the code is checked, as sign-in counts its
   * own, so a guess is never free; the cap spent, the request is cancelled.
   */
  async verify(
    admin: AdminActor,
    id: string,
    code: string,
    now: Date = new Date(),
  ): Promise<AdminAccountRecovery> {
    const row = await this.require(id);
    const status = recoveryStatus(row, now);
    if (status !== 'awaiting_code') {
      throw new AccountRecoveryNotAllowedNowError(status);
    }

    const tally = await this.limiter.consumeAttempt({
      scope: ATTEMPT_SCOPE,
      subject: id,
      maxAttempts: this.otpConfig.maxAttempts,
      ttlMs: Math.max(1, row.codeExpiresAt.getTime() - now.getTime()),
    });
    if (tally.used > this.otpConfig.maxAttempts) {
      await this.recoveries.cancel({ id }, { source: 'code_attempts', now });
      throw new AccountRecoveryCodeInvalidError();
    }

    const token = randomBytes(32).toString('base64url');
    const holdUntil = new Date(now.getTime() + RECOVERY_HOLD_MS);
    const verified = await this.db.transaction(async (tx) => {
      const updated = await this.recoveries.verify(
        id,
        this.hashCode(id, code),
        now,
        holdUntil,
        hashCancelToken(token),
        tx,
      );
      if (updated !== undefined) {
        await this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'account.recovery.verify',
            targetType: RECOVERY_AUDIT_TARGET,
            targetId: id,
            after: { holdUntil: holdUntil.toISOString() },
          },
          now,
          tx,
        );
      }
      return updated;
    });

    if (verified === undefined) {
      if (tally.exhausted) {
        await this.recoveries.cancel({ id }, { source: 'code_attempts', now });
        this.logger.warn(`account recovery code attempts spent, request cancelled: request=${id}`);
      }
      throw new AccountRecoveryCodeInvalidError();
    }

    await this.limiter.clearAttempts(ATTEMPT_SCOPE, id);
    await this.otp.recordCodeEntered(now);
    await this.notify(
      verified.oldEmail,
      renderRecoveryOpenedNotice(maskEmail(verified.newEmail), holdUntil, this.cancelLink(token)),
      'opened',
      id,
    );
    return toView(await this.require(id), now);
  }

  /** Cancelled by an admin, on the user's word or their own judgement, with a reason. */
  async cancel(
    admin: AdminActor,
    id: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AdminAccountRecovery> {
    const row = await this.require(id);
    const cancelled = await this.db.transaction(async (tx) => {
      const updated = await this.recoveries.cancel(
        { id },
        { source: 'admin', adminUserId: admin.adminUserId, reason, now },
        tx,
      );
      if (updated !== undefined) {
        await this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'account.recovery.cancel',
            targetType: RECOVERY_AUDIT_TARGET,
            targetId: id,
            reason,
          },
          now,
          tx,
        );
      }
      return updated;
    });
    if (cancelled === undefined) {
      throw new AccountRecoveryNotAllowedNowError(recoveryStatus(row, now));
    }
    await this.notifyCancelled(cancelled);
    return toView(await this.require(id), now);
  }

  /**
   * The link in the old address's notice. Says nothing either way: an
   * unknown, used or spent token is answered exactly like a good one, so the
   * endpoint cannot be used to test tokens. Good until the move (ADR-0074 § 2).
   */
  async cancelByLink(token: string, now: Date = new Date()): Promise<void> {
    const cancelled = await this.recoveries.cancel(
      { cancelTokenHash: hashCancelToken(token) },
      { source: 'link', now },
    );
    if (cancelled === undefined) {
      return;
    }
    this.logger.log(`account recovery cancelled from the link: request=${cancelled.id}`);
    await this.notifyCancelled(cancelled);
  }

  /**
   * The move. `super_admin` only, never the admin who opened the request, and
   * not before the hold ends. The request, the address, the revocation of
   * every session and the audit row commit together; a move the account can
   * no longer take (the address taken meanwhile, or the account no longer
   * active or no longer at the old address) cancels the request instead.
   */
  async approve(
    admin: AdminActor,
    id: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AdminAccountRecovery> {
    if (!admin.roles.includes('super_admin')) {
      throw new InsufficientAdminPermissionError();
    }
    const row = await this.require(id);
    if (row.openedByAdminId === admin.adminUserId) {
      throw new AccountRecoverySameAdminError();
    }
    const status = recoveryStatus(row, now);
    if (status === 'on_hold' && row.holdUntil !== null) {
      throw new AccountRecoveryHoldRunningError(row.holdUntil);
    }
    if (status !== 'ready') {
      throw new AccountRecoveryNotAllowedNowError(status);
    }

    let moved: AccountRecoveryRow | undefined;
    try {
      moved = await this.db.transaction(async (tx) => {
        const updated = await this.recoveries.markMoved(id, admin.adminUserId, reason, now, tx);
        if (updated === undefined) {
          return undefined;
        }
        const result = await this.mover.move(
          { userId: updated.userId, fromEmail: updated.oldEmail, toEmail: updated.newEmail, now },
          tx,
        );
        if (result !== 'moved') {
          throw new MoveRefused(result);
        }
        await this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'account.recovery.move',
            targetType: RECOVERY_AUDIT_TARGET,
            targetId: id,
            reason,
            after: {
              userId: updated.userId,
              openedByAdminId: updated.openedByAdminId,
              approvedByAdminId: admin.adminUserId,
            },
          },
          now,
          tx,
        );
        return updated;
      });
    } catch (error: unknown) {
      if (!(error instanceof MoveRefused)) {
        throw error;
      }
      this.logger.warn(`account recovery move refused: request=${id} reason=${error.result}`);
      await this.recoveries.cancel({ id }, { source: 'stale', reason: error.result, now });
      if (error.result === 'address-taken') {
        throw new EmailAddressTakenError();
      }
      throw new AccountRecoveryNotAllowedNowError('cancelled');
    }

    if (moved === undefined) {
      // Cancelled, or approved by somebody else, between the read and the write.
      const current = await this.require(id);
      throw new AccountRecoveryNotAllowedNowError(recoveryStatus(current, now));
    }

    this.logger.log(
      `account recovery moved, every session revoked: request=${id} user=${moved.userId} ` +
        `opened_by=${moved.openedByAdminId} approved_by=${admin.adminUserId}`,
    );
    const notice = renderRecoveryMovedNotice(maskEmail(moved.newEmail));
    await this.notify(moved.oldEmail, notice, 'moved', id);
    await this.notify(moved.newEmail, notice, 'moved', id);
    return toView(await this.require(id), now);
  }

  /** Only an old address that was told about the hold is told it ended. */
  private async notifyCancelled(row: AccountRecoveryRow): Promise<void> {
    if (row.codeVerifiedAt === null) {
      return;
    }
    await this.notify(row.oldEmail, renderRecoveryCancelledNotice(), 'cancelled', row.id);
  }

  /**
   * A failed notice is logged, not thrown: the step it reports has committed,
   * and answering an error would invite the admin to do it again.
   */
  private async notify(
    to: string,
    message: { readonly subject: string; readonly text: string },
    kind: string,
    requestId: string,
  ): Promise<void> {
    try {
      await this.mail.send({ to, ...message });
    } catch (error: unknown) {
      this.logger.error(
        `account recovery ${kind} notice failed: request=${requestId} to=${maskEmail(to)} ` +
          `error=${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  private async sendCode(to: string, code: string, now: Date): Promise<void> {
    const ttlMinutes = Math.round(this.otp.codeTtlSeconds() / 60);
    await this.otp.dispatchCode(to, renderRecoveryCodeEmail(code, ttlMinutes), now);
  }

  /** The token rides in the fragment, which a browser never sends, so no access log holds it. */
  private cancelLink(token: string): string {
    const base = this.config.email.recoveryLinkBaseUrl.replace(/\/+$/, '');
    return `${base}/account-recovery/cancel#${token}`;
  }

  /** HMAC of `<request id>|recovery|<code>` under `OTP_CODE_PEPPER`, as the other code flows do. */
  private hashCode(id: string, code: string): string {
    return createHmac('sha256', this.otpConfig.codePepper)
      .update(`${id}|recovery|${code}`)
      .digest('hex');
  }

  private async require(id: string): Promise<AccountRecoveryView> {
    const row = await this.recoveries.find(id);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }
}
