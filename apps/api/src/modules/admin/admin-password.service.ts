import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminPasswordChangeRequest } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { AdminAuthConfig } from './admin.config';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import { ADMIN_CONFIG } from './admin.types';
import { totpSecretContext } from './admin-setup.service';
import { AdminSignInBudget } from './admin-sign-in-budget';
import { hashPassword, verifyPassword } from './credentials/password-hash';
import { SecretBox, SecretBoxError } from '../../common/crypto/secret-box';
import { matchTotpStep } from './credentials/totp';

/**
 * The current password or the code was wrong (#329). One error for both: the
 * caller already holds a session, and a form that said which factor failed
 * would let a stolen session test password guesses without the authenticator.
 */
export class AdminCredentialsInvalidError extends AppError {
  constructor() {
    super(ERROR_CODES.ADMIN_CREDENTIALS_INVALID, 'The password or the code is not valid.', 400);
    this.name = 'AdminCredentialsInvalidError';
    Object.setPrototypeOf(this, AdminCredentialsInvalidError.prototype);
  }
}

/**
 * A signed-in admin changing their own password (#329, ADR-0043 § 2).
 *
 * The session is not enough: the current password **and** a fresh code are
 * required, so a stolen cookie cannot lock its owner out. Every attempt spends
 * the account's sign-in budget — the same counter, keyed by the same email —
 * so a wrong guess here counts toward the same lockout as one on the sign-in
 * form, and the change cannot be used to guess at a slower rate than sign-in
 * allows.
 */
@Injectable()
export class AdminPasswordService {
  private readonly logger = new Logger(AdminPasswordService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly admins: AdminRepository,
    private readonly budget: AdminSignInBudget,
    @Inject(ADMIN_CONFIG) config: AdminAuthConfig,
  ) {
    this.box = new SecretBox(config.totpEncryptionKey);
  }

  async changeOwn(
    actor: AdminActor,
    input: AdminPasswordChangeRequest,
    now: Date = new Date(),
  ): Promise<void> {
    await this.budget.spend(actor.email, 'password change');

    const admin = await this.admins.findLiveAdminById(actor.adminUserId);
    if (
      admin === undefined ||
      admin.passwordHash === null ||
      admin.totpSecretEncrypted === null ||
      !(await verifyPassword(input.currentPassword, admin.passwordHash))
    ) {
      throw this.fail(actor, 'wrong_password');
    }

    let secret: Buffer;
    try {
      secret = this.box.open(admin.totpSecretEncrypted, totpSecretContext(admin.id));
    } catch (error: unknown) {
      if (error instanceof SecretBoxError) {
        this.logger.error(`admin ${admin.id}: stored TOTP secret failed to open`);
        throw this.fail(actor, 'totp_secret_unreadable');
      }
      throw error;
    }
    const step = matchTotpStep(secret, input.code, now, admin.lastTotpStep);
    // Claimed, as on sign-in: one code is spent once, here or there.
    if (step === undefined || !(await this.admins.claimTotpStep(admin.id, step))) {
      throw this.fail(actor, 'wrong_or_reused_code');
    }

    // After both factors, before the transaction: scrypt is slow, and a lock
    // held across it would serialise nothing useful.
    const passwordHash = await hashPassword(input.newPassword);
    const verifiedHash = admin.passwordHash;
    await this.admins.transaction(async (tx) => {
      // Conditional on the hash just verified: a super_admin's reset landing
      // in between has cleared it, and must not be undone by this write.
      const changed = await this.admins.changePassword(
        {
          adminUserId: admin.id,
          expectedPasswordHash: verifiedHash,
          passwordHash,
          keepSessionId: actor.sessionId,
        },
        now,
        tx,
      );
      if (!changed) {
        throw this.fail(actor, 'password_changed_meanwhile');
      }
      // No before or after: the only thing that changed is a secret.
      await this.admins.appendAudit(
        {
          adminUserId: admin.id,
          action: 'admin.password.change',
          targetType: 'admin_user',
          targetId: admin.id,
        },
        now,
        tx,
      );
    });
  }

  private fail(actor: AdminActor, reason: string): AdminCredentialsInvalidError {
    this.logger.warn(`admin ${actor.adminUserId}: password change refused: ${reason}`);
    return new AdminCredentialsInvalidError();
  }
}
