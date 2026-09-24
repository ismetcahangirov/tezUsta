import { Injectable } from '@nestjs/common';
import type { AdminAccount, AdminInvitationIssued, AdminRole } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { NotFoundError } from '../../common/errors/not-found.error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import type { AdminUserRow } from '../../infra/database/schema/admin';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import { AdminSetupService } from './admin-setup.service';

/**
 * The refusals that keep the panel manageable (ADR-0043 § 1). Distinct codes,
 * because the panel says a different sentence for each and none is a retry.
 */
export class AdminSelfActionError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ADMIN_SELF_ACTION_REFUSED,
      'You cannot do this to your own account. Ask another super admin.',
      409,
    );
    this.name = 'AdminSelfActionError';
    Object.setPrototypeOf(this, AdminSelfActionError.prototype);
  }
}

export class LastSuperAdminError extends AppError {
  constructor() {
    super(ERROR_CODES.ADMIN_LAST_SUPER_ADMIN, 'This would leave no active super admin.', 409);
    this.name = 'LastSuperAdminError';
    Object.setPrototypeOf(this, LastSuperAdminError.prototype);
  }
}

export class AdminEmailTakenError extends AppError {
  constructor() {
    super(ERROR_CODES.ADMIN_EMAIL_TAKEN, 'An admin with this email already exists.', 409);
    this.name = 'AdminEmailTakenError';
    Object.setPrototypeOf(this, AdminEmailTakenError.prototype);
  }
}

/**
 * Admin account management for `super_admin` (ADR-0043 § 1, § 3).
 *
 * Every change runs under one transaction-scoped advisory lock on the roster,
 * so "is there still another active super_admin?" is answered and acted on
 * atomically: two super_admins demoting each other at the same moment leave
 * one, never none. Nothing is deleted — a disabled admin keeps their row, and
 * every audit row that names them stays readable.
 */
@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly admins: AdminRepository,
    private readonly setup: AdminSetupService,
  ) {}

  async list(): Promise<AdminAccount[]> {
    return this.admins.listAccounts();
  }

  async invite(
    actor: AdminActor,
    input: { email: string; displayName: string; roles: readonly AdminRole[] },
    now: Date = new Date(),
  ): Promise<AdminInvitationIssued> {
    return this.admins.transaction(async (tx) => {
      await this.admins.lockRoster(tx);
      if ((await this.admins.findLiveAdminByEmail(input.email, tx)) !== undefined) {
        throw new AdminEmailTakenError();
      }
      const created = await this.admins.createAdmin(
        { ...input, grantedByAdminId: actor.adminUserId },
        tx,
      );
      const issued = await this.setup.issueInvitation(created.id, actor.adminUserId, now, tx);
      await this.admins.appendAudit(
        {
          adminUserId: actor.adminUserId,
          action: 'admin.invite',
          targetType: 'admin_user',
          targetId: created.id,
          after: { email: created.email, roles: [...input.roles].sort() },
        },
        now,
        tx,
      );
      return {
        admin: await this.requireAccount(created.id, tx),
        setupLink: issued.link,
        setupLinkExpiresAt: issued.expiresAt.toISOString(),
      };
    });
  }

  async disable(
    actor: AdminActor,
    adminUserId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AdminAccount> {
    return this.change(actor, adminUserId, async (target, tx) => {
      if (target.status === 'disabled') {
        return;
      }
      await this.refuseLosingLastSuperAdmin(target, tx);
      await this.admins.setStatus(target.id, 'disabled', tx);
      // Immediately, not at the next token expiry: a disabled admin's open
      // panel stops working on its next request.
      await this.admins.revokeAllSessions(target.id, now, tx);
      await this.admins.revokeLiveInvitations(target.id, now, tx);
      await this.admins.appendAudit(
        {
          adminUserId: actor.adminUserId,
          action: 'admin.disable',
          targetType: 'admin_user',
          targetId: target.id,
          reason,
          before: { status: 'active' },
          after: { status: 'disabled' },
        },
        now,
        tx,
      );
    });
  }

  async enable(
    actor: AdminActor,
    adminUserId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AdminAccount> {
    return this.change(actor, adminUserId, async (target, tx) => {
      if (target.status === 'active') {
        return;
      }
      await this.admins.setStatus(target.id, 'active', tx);
      await this.admins.appendAudit(
        {
          adminUserId: actor.adminUserId,
          action: 'admin.enable',
          targetType: 'admin_user',
          targetId: target.id,
          reason,
          before: { status: 'disabled' },
          after: { status: 'active' },
        },
        now,
        tx,
      );
    });
  }

  async setRoles(
    actor: AdminActor,
    adminUserId: string,
    roles: readonly AdminRole[],
    reason: string,
    now: Date = new Date(),
  ): Promise<AdminAccount> {
    return this.change(actor, adminUserId, async (target, tx) => {
      const before = [...(await this.admins.findRoles(target.id, tx))].sort();
      const after = [...new Set(roles)].sort();
      if (before.join() === after.join()) {
        return;
      }
      if (before.includes('super_admin') && !after.includes('super_admin')) {
        await this.refuseLosingLastSuperAdmin(target, tx);
      }
      await this.admins.replaceRoles(target.id, after, actor.adminUserId, tx);
      await this.admins.appendAudit(
        {
          adminUserId: actor.adminUserId,
          action: 'admin.roles.set',
          targetType: 'admin_user',
          targetId: target.id,
          reason,
          before: { roles: before },
          after: { roles: after },
        },
        now,
        tx,
      );
    });
  }

  async resetSecondFactor(
    actor: AdminActor,
    adminUserId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AdminInvitationIssued> {
    return this.admins.transaction(async (tx) => {
      await this.admins.lockRoster(tx);
      const target = await this.requireTarget(actor, adminUserId, tx);
      if (target.status !== 'active') {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Enable this admin before resetting their second factor.',
          409,
        );
      }
      await this.admins.clearCredentials(target.id, now, tx);
      const issued = await this.setup.issueInvitation(target.id, actor.adminUserId, now, tx);
      await this.admins.appendAudit(
        {
          adminUserId: actor.adminUserId,
          action: 'admin.second_factor.reset',
          targetType: 'admin_user',
          targetId: target.id,
          reason,
          before: { enrolled: target.totpEnrolledAt !== null },
          after: { enrolled: false },
        },
        now,
        tx,
      );
      return {
        admin: await this.requireAccount(target.id, tx),
        setupLink: issued.link,
        setupLinkExpiresAt: issued.expiresAt.toISOString(),
      };
    });
  }

  private async change(
    actor: AdminActor,
    adminUserId: string,
    work: (target: AdminUserRow, tx: DatabaseExecutor) => Promise<void>,
  ): Promise<AdminAccount> {
    return this.admins.transaction(async (tx) => {
      await this.admins.lockRoster(tx);
      const target = await this.requireTarget(actor, adminUserId, tx);
      await work(target, tx);
      return this.requireAccount(target.id, tx);
    });
  }

  private async requireTarget(
    actor: AdminActor,
    adminUserId: string,
    tx: DatabaseExecutor,
  ): Promise<AdminUserRow> {
    if (adminUserId === actor.adminUserId) {
      throw new AdminSelfActionError();
    }
    const target = await this.admins.findLiveAdminById(adminUserId, tx);
    if (target === undefined) {
      throw new NotFoundError();
    }
    return target;
  }

  /**
   * Refuses when `target` is the only active super_admin. Call under the
   * roster lock. A disabled super_admin is not counted, so demoting one never
   * trips this.
   */
  private async refuseLosingLastSuperAdmin(
    target: AdminUserRow,
    tx: DatabaseExecutor,
  ): Promise<void> {
    if (target.status !== 'active') {
      return;
    }
    const roles = await this.admins.findRoles(target.id, tx);
    if (!roles.includes('super_admin')) {
      return;
    }
    if ((await this.admins.countActiveSuperAdmins(tx)) <= 1) {
      throw new LastSuperAdminError();
    }
  }

  private async requireAccount(adminUserId: string, tx: DatabaseExecutor): Promise<AdminAccount> {
    const account = await this.admins.findAccount(adminUserId, tx);
    if (account === undefined) {
      throw new NotFoundError();
    }
    return account;
  }
}
