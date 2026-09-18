import { Inject, Injectable } from '@nestjs/common';

import type { AdminAuthConfig } from './admin.config';
import { AdminRepository } from './admin.repository';
import { AdminTokenService } from './admin-token.service';
import { ADMIN_CONFIG } from './admin.types';

/**
 * Opens and closes admin sessions.
 *
 * **Nothing in the HTTP surface calls `start` yet**, and that is ADR-0014's
 * own plan rather than an omission: admin *authorization* ships with the
 * authorization layer, while admin *credential issuance* — email, password,
 * mandatory TOTP, the sign-in form — ships in EPIC 13. Until then admin
 * endpoints "exist, are guarded, and are covered by tests, but no production
 * admin credential is issued", which is exactly what this class makes
 * possible: a provisioning script or a test opens a session directly, and
 * everything above it is finished.
 *
 * There is no refresh half. Refresh exists to keep a long login alive across a
 * short access token, and there is no login yet to keep alive.
 */
@Injectable()
export class AdminSessionService {
  constructor(
    private readonly admins: AdminRepository,
    private readonly tokens: AdminTokenService,
    @Inject(ADMIN_CONFIG) private readonly config: AdminAuthConfig,
  ) {}

  async start(
    adminUserId: string,
    now: Date = new Date(),
  ): Promise<{ accessToken: string; expiresAt: Date; sessionId: string }> {
    const session = await this.admins.createSession(
      adminUserId,
      new Date(now.getTime() + this.config.sessionTtlMs),
    );
    const { token, expiresAt } = this.tokens.issueAccessToken(
      { adminUserId, sessionId: session.id },
      now,
    );
    return { accessToken: token, expiresAt, sessionId: session.id };
  }

  async revoke(sessionId: string, now: Date = new Date()): Promise<void> {
    await this.admins.revokeSession(sessionId, now);
  }
}
