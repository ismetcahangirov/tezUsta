import { Injectable } from '@nestjs/common';

import type { AdminAuthConfig } from './admin.config';
import { ADMIN_CONFIG } from './admin.types';
import type { AdminAccessTokenClaims, AdminActor } from './admin.types';
import { Inject } from '@nestjs/common';
import { AdminRepository } from './admin.repository';
import { InvalidAdminTokenError } from './admin-token.service';
import { permissionsFor } from './admin-permissions';

/**
 * Turns verified claims into the admin the request is actually from,
 * **re-reading the database every time**.
 *
 * A token claim is a cache, not an authority — the same rule the consumer
 * `ActorService` follows, and it matters more here. An admin token lives
 * fifteen minutes; the whole point of the session row is that disabling an
 * account, revoking a session or walking away from a desk takes effect before
 * that, and none of those facts are in the token.
 *
 * Four things are checked that the signature cannot see: the session exists
 * and belongs to this admin, it has not been revoked, it has not expired, and
 * it has not been idle past the timeout. The admin row itself must still be
 * live and `active`.
 */
@Injectable()
export class AdminActorService {
  constructor(
    private readonly admins: AdminRepository,
    @Inject(ADMIN_CONFIG) private readonly config: AdminAuthConfig,
  ) {}

  async resolve(claims: AdminAccessTokenClaims, now: Date = new Date()): Promise<AdminActor> {
    // Roles in the same round trip as the other two reads, and never from the
    // token: a revoked role must stop working on the very next request
    // (ADR-0043 § 1).
    const [session, admin, roles] = await Promise.all([
      this.admins.findSessionById(claims.sid),
      this.admins.findLiveAdminById(claims.sub),
      this.admins.findRoles(claims.sub),
    ]);

    if (session === undefined) {
      throw new InvalidAdminTokenError('unknown_session');
    }
    if (session.adminUserId !== claims.sub) {
      throw new InvalidAdminTokenError('session_admin_mismatch');
    }
    if (session.revokedAt !== null) {
      throw new InvalidAdminTokenError('session_revoked');
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidAdminTokenError('session_expired');
    }
    // The idle timeout, which is the one check with no equivalent on the
    // consumer path (ADR-0014). Measured from the last authenticated request
    // rather than from sign-in, so an admin working continuously is never
    // interrupted and one who walked away is locked out.
    if (now.getTime() - session.lastUsedAt.getTime() > this.config.idleTimeoutMs) {
      throw new InvalidAdminTokenError('session_idle_timeout');
    }
    if (admin === undefined) {
      throw new InvalidAdminTokenError('unknown_admin');
    }
    if (admin.status !== 'active') {
      throw new InvalidAdminTokenError('admin_not_active');
    }

    // Only after every check passes. Touching first would keep a revoked or
    // idle-expired session looking fresh on each rejected attempt.
    await this.admins.touchSession(session.id, now);

    return {
      adminUserId: admin.id,
      sessionId: session.id,
      email: admin.email,
      displayName: admin.displayName,
      roles,
      permissions: permissionsFor(roles),
    };
  }
}
