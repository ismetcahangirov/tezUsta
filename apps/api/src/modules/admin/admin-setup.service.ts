import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { AdminSetupCompleteRequest, AdminSetupStart } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import type { AdminAuthConfig } from './admin.config';
import { AdminRepository } from './admin.repository';
import { ADMIN_CONFIG } from './admin.types';
import { hashPassword } from './credentials/password-hash';
import { SecretBox, SecretBoxError } from './credentials/secret-box';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
} from './credentials/totp';

/** ADR-0043 § 3: a setup link lives 24 hours. */
export const ADMIN_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an offered TOTP secret may take to be proven. */
const ENROLMENT_TTL_MS = 15 * 60 * 1000;
const TOKEN_BYTES = 32;

export class AdminSetupLinkInvalidError extends AppError {
  constructor() {
    super(ERROR_CODES.ADMIN_SETUP_LINK_INVALID, 'This setup link is not valid.', 400);
    this.name = 'AdminSetupLinkInvalidError';
    Object.setPrototypeOf(this, AdminSetupLinkInvalidError.prototype);
  }
}

export class AdminTotpCodeInvalidError extends AppError {
  constructor() {
    super(ERROR_CODES.ADMIN_TOTP_CODE_INVALID, 'The authenticator code is not valid.', 400);
    this.name = 'AdminTotpCodeInvalidError';
    Object.setPrototypeOf(this, AdminTotpCodeInvalidError.prototype);
  }
}

/** The SHA-256 hex digest a token is stored and looked up by. Never the token. */
export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The context a stored TOTP secret is sealed under — bound to its row. */
export function totpSecretContext(adminUserId: string): string {
  return `admin-totp:${adminUserId}`;
}

function enrolmentContext(invitationId: string): string {
  return `admin-enrolment:${invitationId}`;
}

export interface IssuedInvitation {
  readonly link: string;
  readonly expiresAt: Date;
}

/**
 * Setup links and first-time credentials (ADR-0043 § 2–3).
 *
 * The flow is two calls and writes nothing until the second succeeds:
 *
 * 1. `start` checks the link and offers a fresh TOTP secret, sealed into an
 *    `enrolment` blob bound to this invitation and valid for 15 minutes.
 * 2. `complete` opens that blob, proves a code against it, and only then
 *    writes the password, the secret (sealed again, now bound to the admin
 *    row) and spends the link — under a row lock, so a link completes once.
 *
 * A half-enrolled account is therefore unrepresentable: either the admin
 * proved an authenticator, or nothing changed.
 */
@Injectable()
export class AdminSetupService {
  private readonly box: SecretBox;

  constructor(
    private readonly admins: AdminRepository,
    @Inject(ADMIN_CONFIG) private readonly config: AdminAuthConfig,
  ) {
    this.box = new SecretBox(config.totpEncryptionKey);
  }

  /**
   * A new single-use link for `adminUserId`, replacing any live one. The
   * token is returned inside the link, once; only its digest is stored.
   */
  async issueInvitation(
    adminUserId: string,
    createdByAdminId: string | null,
    now: Date = new Date(),
    executor?: DatabaseExecutor,
  ): Promise<IssuedInvitation> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(now.getTime() + ADMIN_INVITATION_TTL_MS);
    await this.admins.replaceInvitation(
      { adminUserId, tokenHash: digestToken(token), createdByAdminId, expiresAt },
      now,
      executor,
    );
    // The token rides in the fragment: a browser never sends it to a server,
    // so it cannot land in an access log or a Referer header.
    return { link: `${this.config.setupLinkBaseUrl}/setup#${token}`, expiresAt };
  }

  async start(token: string, now: Date = new Date()): Promise<AdminSetupStart> {
    const found = await this.admins.findUsableInvitation(digestToken(token), now);
    if (found === undefined) {
      throw new AdminSetupLinkInvalidError();
    }
    const secret = generateTotpSecret();
    const enrolment = this.box.seal(
      Buffer.from(
        JSON.stringify({ secret: base32Encode(secret), exp: now.getTime() + ENROLMENT_TTL_MS }),
        'utf8',
      ),
      enrolmentContext(found.invitation.id),
    );
    return {
      email: found.admin.email,
      displayName: found.admin.displayName,
      totpSecret: base32Encode(secret),
      otpauthUri: otpauthUri(secret, found.admin.email),
      enrolment,
    };
  }

  async complete(input: AdminSetupCompleteRequest, now: Date = new Date()): Promise<void> {
    // Hashed before the transaction: scrypt takes a few hundred milliseconds,
    // and a row lock held across it would serialise nothing useful.
    const passwordHash = await hashPassword(input.password);

    await this.admins.transaction(async (tx) => {
      const found = await this.admins.findUsableInvitation(digestToken(input.token), now, tx, true);
      if (found === undefined) {
        throw new AdminSetupLinkInvalidError();
      }

      const secret = this.openEnrolment(input.enrolment, found.invitation.id, now);
      const step = matchTotpStep(secret, input.code, now, null);
      if (step === undefined) {
        throw new AdminTotpCodeInvalidError();
      }

      await this.admins.completeSetup(
        {
          adminUserId: found.admin.id,
          invitationId: found.invitation.id,
          passwordHash,
          totpSecretEncrypted: this.box.seal(secret, totpSecretContext(found.admin.id)),
          lastTotpStep: step,
        },
        now,
        tx,
      );
      await this.admins.appendAudit(
        {
          adminUserId: found.admin.id,
          action: 'admin.setup.complete',
          targetType: 'admin_user',
          targetId: found.admin.id,
        },
        now,
        tx,
      );
    });
  }

  /**
   * The secret `start` offered for this invitation. An enrolment sealed for
   * another invitation, tampered with, or older than 15 minutes is the same
   * `ADMIN_SETUP_LINK_INVALID` — the page restarts from the link.
   */
  private openEnrolment(enrolment: string, invitationId: string, now: Date): Buffer {
    let payload: unknown;
    try {
      payload = JSON.parse(
        this.box.open(enrolment, enrolmentContext(invitationId)).toString('utf8'),
      );
    } catch (error: unknown) {
      if (error instanceof SecretBoxError || error instanceof SyntaxError) {
        throw new AdminSetupLinkInvalidError();
      }
      throw error;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { secret?: unknown }).secret !== 'string' ||
      typeof (payload as { exp?: unknown }).exp !== 'number' ||
      (payload as { exp: number }).exp <= now.getTime()
    ) {
      throw new AdminSetupLinkInvalidError();
    }
    return base32Decode((payload as { secret: string }).secret);
  }
}
