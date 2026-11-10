import { createHmac } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { maskEmail } from '../../infra/email/email-address';
import type { EmailSender } from '../../infra/email/email-sender.types';
import { EMAIL_SENDER } from '../../infra/email/email-sender.types';
import { RateLimiterService } from '../../infra/rate-limit/rate-limiter.service';
import { UsersRepository } from '../users/users.repository';
import type { AccountEmailMoveResult } from './account-email-mover';
import { AccountEmailMover } from './account-email-mover';
import { EmailChangeRepository } from './email-change.repository';
import type { EmailChangeCodeTarget } from './otp-code';
import { generateOtpCode, renderEmailChangeCodeEmail, renderEmailChangedNotice } from './otp-code';
import type { OtpConfig } from './otp.config';
import { OtpService } from './otp.service';
import { OTP_CONFIG } from './otp.tokens';

/**
 * The Redis scope the per-change attempt cap counts under, keyed by the
 * change's id, so starting a new change starts a fresh budget (as sign-in's
 * `otp-verify` does per challenge).
 */
const ATTEMPT_SCOPE = 'email-change-verify';

export class EmailChangeSameAddressError extends AppError {
  constructor() {
    super(
      ERROR_CODES.EMAIL_CHANGE_SAME_ADDRESS,
      'This is already the address the account signs in with.',
      422,
    );
    this.name = 'EmailChangeSameAddressError';
    Object.setPrototypeOf(this, EmailChangeSameAddressError.prototype);
  }
}

/** One answer for every way a confirm can fail on its codes; see `ERROR_CODES.EMAIL_CHANGE_CODE_INVALID`. */
export class EmailChangeCodeInvalidError extends AppError {
  constructor() {
    super(ERROR_CODES.EMAIL_CHANGE_CODE_INVALID, 'A code is invalid or has expired.', 422);
    this.name = 'EmailChangeCodeInvalidError';
    Object.setPrototypeOf(this, EmailChangeCodeInvalidError.prototype);
  }
}

export class EmailAddressTakenError extends AppError {
  constructor() {
    super(ERROR_CODES.EMAIL_ADDRESS_TAKEN, 'Another account already uses this address.', 409);
    this.name = 'EmailAddressTakenError';
    Object.setPrototypeOf(this, EmailAddressTakenError.prototype);
  }
}

/** Carries a refused move out of the transaction, so the completion rolls back with it. */
class MoveRefused extends Error {
  constructor(readonly result: Exclude<AccountEmailMoveResult, 'moved'>) {
    super(`email move refused: ${result}`);
  }
}

export interface EmailChangeStarted {
  readonly expiresInSeconds: number;
}

/**
 * A signed-in user changes the address they sign in with
 * ([ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md) § 1,
 * #514): a code to the new address **and** a code to the current one, both
 * entered together.
 *
 * Two codes, because the change is a credential change made from a session:
 * a code to the new address alone would let anyone holding an unlocked phone
 * move the account to a mailbox they control. A user who no longer reads the
 * current address is ADR-0074 § 2's case, recovery through support.
 *
 * **Start does not look the new address up.** Whether another account holds
 * it is answered only at confirm, after both codes were right, so only to
 * somebody who has proven they read that inbox. Asking at start would make
 * this an address-enumeration endpoint for any signed-in account, which
 * sign-in itself is built never to be (ADR-0072).
 */
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);

  constructor(
    private readonly changes: EmailChangeRepository,
    private readonly mover: AccountEmailMover,
    private readonly users: UsersRepository,
    private readonly otp: OtpService,
    private readonly limiter: RateLimiterService,
    @Inject(EMAIL_SENDER) private readonly mail: EmailSender,
    @Inject(OTP_CONFIG) private readonly config: OtpConfig,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  /**
   * Starts a change, replacing any change the user already has pending, and
   * sends the two codes.
   *
   * Replacing rather than refusing: a user who mistyped the new address must
   * be able to start again at once, not wait out the first pair's five
   * minutes. The per-user rate limit on the route bounds how often.
   *
   * The current address is mailed first. If the sending budget refuses, the
   * new address, which may be anyone's, has received nothing.
   */
  async start(
    userId: string,
    newEmail: string,
    now: Date = new Date(),
  ): Promise<EmailChangeStarted> {
    const account = await this.users.findByIdWithRoles(userId);
    if (account === undefined) {
      // Unreachable behind the authentication guard, which re-reads the user
      // on every request. Answered as a bad code rather than a 404, so the
      // route never says anything about account existence.
      throw new EmailChangeCodeInvalidError();
    }
    const oldEmail = account.user.email;
    if (newEmail === oldEmail) {
      throw new EmailChangeSameAddressError();
    }

    const id = uuidV7();
    const currentCode = generateOtpCode(this.config.length);
    const newCode = generateOtpCode(this.config.length);

    await this.changes.replaceLive(
      {
        id,
        userId,
        oldEmail,
        newEmail,
        currentCodeHash: this.hashCode(id, 'current', currentCode),
        newCodeHash: this.hashCode(id, 'new', newCode),
        expiresAt: new Date(now.getTime() + this.config.ttlMs),
      },
      now,
    );

    const ttlMinutes = Math.round(this.otp.codeTtlSeconds() / 60);
    await this.otp.dispatchCode(
      oldEmail,
      renderEmailChangeCodeEmail(currentCode, ttlMinutes, 'current'),
      now,
    );
    await this.otp.dispatchCode(
      newEmail,
      renderEmailChangeCodeEmail(newCode, ttlMinutes, 'new'),
      now,
    );

    this.logger.log(
      `email change started: change=${id} user=${userId} ` +
        `from=${maskEmail(oldEmail)} to=${maskEmail(newEmail)}`,
    );

    return { expiresInSeconds: this.otp.codeTtlSeconds() };
  }

  /**
   * Confirms the pending change with both codes and moves the account.
   *
   * The order mirrors sign-in's verify, for the same reasons:
   *
   * 1. Find the live change. None is the same failure as a wrong code.
   * 2. **Count the attempt before checking the codes**, so a guess is never free.
   * 3. In one transaction: complete the change with both digests in the
   *    `WHERE`, then move the address and revoke every session. A refused move
   *    rolls the completion back, so a change is never marked done for an
   *    address the account does not have.
   * 4. After commit, tell the old address. A failed notice is logged, not
   *    thrown: the change has happened, and answering an error would invite
   *    the user to do it again.
   */
  async confirm(
    userId: string,
    currentCode: string,
    newCode: string,
    now: Date = new Date(),
  ): Promise<void> {
    const change = await this.changes.findLiveForUser(userId, now);
    if (change === undefined) {
      throw new EmailChangeCodeInvalidError();
    }

    const tally = await this.limiter.consumeAttempt({
      scope: ATTEMPT_SCOPE,
      subject: change.id,
      maxAttempts: this.config.maxAttempts,
      ttlMs: Math.max(1, change.expiresAt.getTime() - now.getTime()),
    });
    if (tally.used > this.config.maxAttempts) {
      await this.changes.invalidate(change.id, 'attempts_exhausted', now);
      throw new EmailChangeCodeInvalidError();
    }

    let completed: boolean;
    try {
      completed = await this.db.transaction(async (tx) => {
        const row = await this.changes.complete(
          change.id,
          this.hashCode(change.id, 'current', currentCode),
          this.hashCode(change.id, 'new', newCode),
          now,
          tx,
        );
        if (row === undefined) {
          return false;
        }
        const result = await this.mover.move(
          { userId, fromEmail: change.oldEmail, toEmail: change.newEmail, now },
          tx,
        );
        if (result !== 'moved') {
          throw new MoveRefused(result);
        }
        return true;
      });
    } catch (error: unknown) {
      if (error instanceof MoveRefused) {
        this.logger.warn(
          `email change refused at move: change=${change.id} user=${userId} reason=${error.result}`,
        );
        if (error.result === 'address-taken') {
          throw new EmailAddressTakenError();
        }
        // `stale`: the account stopped being active, or its address moved by
        // another path (#515) after this change started. The pair can never
        // succeed now, so it is retired.
        await this.changes.invalidate(change.id, 'superseded', now);
        throw new EmailChangeCodeInvalidError();
      }
      throw error;
    }

    if (!completed) {
      if (tally.exhausted) {
        await this.changes.invalidate(change.id, 'attempts_exhausted', now);
        this.logger.warn(
          `email change attempt cap reached, change invalidated: change=${change.id} user=${userId}`,
        );
      }
      throw new EmailChangeCodeInvalidError();
    }

    await this.limiter.clearAttempts(ATTEMPT_SCOPE, change.id);
    // Two codes reached people who entered them: the breaker's numerator.
    await this.otp.recordCodeEntered(now);
    await this.otp.recordCodeEntered(now);

    this.logger.log(
      `email change completed, every session revoked: change=${change.id} user=${userId} ` +
        `from=${maskEmail(change.oldEmail)} to=${maskEmail(change.newEmail)}`,
    );

    await this.notifyOldAddress(change.oldEmail, change.newEmail);
  }

  private async notifyOldAddress(oldEmail: string, newEmail: string): Promise<void> {
    try {
      await this.mail.send({ to: oldEmail, ...renderEmailChangedNotice(maskEmail(newEmail)) });
    } catch (error: unknown) {
      this.logger.error(
        `email change notice failed: to=${maskEmail(oldEmail)} ` +
          `error=${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  /**
   * HMAC of `<change id>|<target>|<code>` under `OTP_CODE_PEPPER`: keyed and
   * deterministic, like sign-in's, so it can be compared inside the completing
   * `UPDATE`. The target is bound in, so the code mailed to one address can
   * never stand in for the other's, even if the two draws were equal.
   */
  private hashCode(changeId: string, target: EmailChangeCodeTarget, code: string): string {
    return createHmac('sha256', this.config.codePepper)
      .update(`${changeId}|${target}|${code}`)
      .digest('hex');
  }
}
