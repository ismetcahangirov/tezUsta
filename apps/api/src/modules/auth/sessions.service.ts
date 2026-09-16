import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { UsersRepository } from '../users/users.repository';
import type { AuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import type { DeviceInfo, SessionSummary, TokenPair } from './auth.types';
import { SessionsRepository } from './sessions.repository';
import { TokenService } from './token.service';

/**
 * Raised when the account exists but may not open a session — suspended by an
 * admin, or soft-deleted.
 *
 * Not an enumeration risk at this point in the flow: on the consumer path a
 * session is only ever started after OTP verification has proven the caller
 * owns the number, so they already know the account exists. The endpoint that
 * must answer identically for known and unknown numbers is the OTP *request*
 * (issue #29), which never reaches this service.
 */
export class AccountNotActiveError extends AppError {
  constructor() {
    super(ERROR_CODES.FORBIDDEN, 'This account is not active.', 403);
    this.name = 'AccountNotActiveError';
    Object.setPrototypeOf(this, AccountNotActiveError.prototype);
  }
}

/**
 * The single 401 every refresh failure answers with — unknown token, wrong
 * secret, expired, revoked session, or a replay that just revoked the family.
 *
 * One shape for all of them, for the same reason `InvalidAccessTokenError`
 * has one: a client that can tell "this token was already used" from "this
 * token never existed" has been handed a way to probe which refresh tokens
 * are real. The cause is logged server-side instead.
 */
export class InvalidRefreshTokenError extends AppError {
  readonly reason: RefreshFailureReason;

  constructor(reason: RefreshFailureReason) {
    super(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    this.name = 'InvalidRefreshTokenError';
    this.reason = reason;
    Object.setPrototypeOf(this, InvalidRefreshTokenError.prototype);
  }
}

export type RefreshFailureReason =
  | 'malformed'
  | 'unknown_token'
  | 'bad_secret'
  | 'token_expired'
  | 'unknown_session'
  | 'session_revoked'
  | 'session_expired'
  | 'reuse_detected';

/**
 * Who the session is for, plus whatever the client said about the device.
 *
 * Deliberately **no `roles` field.** Roles are read from the database inside
 * {@link SessionsService.startSession}; letting a caller pass them in would
 * make "mint a master token for a user who holds no master grant" a
 * one-argument mistake, in the one place where a mistake is a privilege
 * escalation.
 */
export interface StartSessionInput {
  readonly userId: string;
  readonly device?: DeviceInfo | undefined;
}

/**
 * Owns the stateful half of the token model: which device sessions exist, when
 * they end, and which refresh token is currently live for each
 * (`docs/architecture/authentication.md` § Sessions and devices).
 *
 * Sign-in itself is not here. OTP verification (issue #29) proves the phone
 * number and then calls {@link startSession}; the admin path (EPIC 13) will
 * prove a different credential and must not reach this service at all, because
 * the two token families deliberately share no issuer and no refresh family
 * (ADR-0014).
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Opens a device session and returns the first access/refresh pair.
   *
   * Status and roles come from the database here, not from the caller. A
   * suspended account cannot open a new session at all, which is the other
   * half of the guarantee in `docs/architecture/authentication.md`: an
   * existing access token stays valid for at most fifteen minutes after
   * suspension, and no new one is ever minted.
   *
   * The session's `expires_at` is set once, here, from `JWT_REFRESH_TTL`, and
   * rotation never extends it — otherwise a client that refreshes every
   * fifteen minutes would hold a session that never ends, and "30-day refresh
   * token" would describe nothing.
   */
  async startSession(input: StartSessionInput, now: Date = new Date()): Promise<TokenPair> {
    const found = await this.users.findByIdWithRoles(input.userId);
    if (found === undefined) {
      // Soft-deleted or never existed. Both are "there is nobody to open a
      // session for", and the caller (OTP verification) has already decided
      // what the client is told.
      throw new AccountNotActiveError();
    }
    if (found.user.status !== 'active') {
      throw new AccountNotActiveError();
    }

    const sessionId = uuidV7();
    const refreshTokenExpiresAt = new Date(now.getTime() + this.config.refreshTtlMs);
    const minted = this.tokens.mintRefreshToken();

    await this.sessions.create({
      sessionId,
      userId: input.userId,
      deviceId: input.device?.deviceId,
      userAgent: input.device?.userAgent,
      sessionExpiresAt: refreshTokenExpiresAt,
      refreshTokenId: minted.id,
      refreshTokenHash: minted.tokenHash,
    });

    const access = this.tokens.issueAccessToken(
      { userId: input.userId, sessionId, roles: found.roles },
      now,
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: minted.token,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Rotates a refresh token: spends the one presented and returns a new pair.
   *
   * **Every refresh returns a new refresh token and invalidates the one
   * presented** (`docs/architecture/authentication.md` § Refresh rotation with
   * reuse detection). Without rotation a stolen refresh token is a permanent
   * credential; with it, theft becomes a short window plus a detectable event.
   *
   * The order of the checks below is deliberate:
   *
   * 1. Shape, existence, secret. A token that is not ours at all is a plain
   *    401 and **never** revokes anything — the presenter has proved nothing
   *    except that they can type, and a typo in a secret must not sign a user
   *    out of every device they own.
   * 2. The session. A revoked or expired family cannot be refreshed, and
   *    replaying an old token against an already-dead session is not new
   *    information, so it does not re-trigger the alarm either.
   * 3. Consumption, as one conditional `UPDATE`. Winning it is what entitles
   *    this call to rotate.
   * 4. Losing it means the token was already spent — by a concurrent retry
   *    moments ago, or by a thief. {@link isWithinReuseGrace} is the only
   *    thing that separates those two, and it is a clock comparison rather
   *    than a guess about intent.
   */
  async refresh(presentedToken: string, now: Date = new Date()): Promise<TokenPair> {
    const parsed = this.tokens.parseRefreshToken(presentedToken);
    if (parsed === null) {
      throw new InvalidRefreshTokenError('malformed');
    }

    const stored = await this.sessions.findRefreshTokenById(parsed.id);
    if (stored === undefined) {
      throw new InvalidRefreshTokenError('unknown_token');
    }
    if (!this.tokens.refreshSecretMatches(parsed.secret, stored.tokenHash)) {
      // A real token id with a wrong secret. Tempting to treat as an attack —
      // and deliberately not, because the id half travels in the clear and a
      // truncated copy-paste produces exactly this. Revoking here would let
      // anyone who ever saw one token id sign that user out at will.
      throw new InvalidRefreshTokenError('bad_secret');
    }
    if (stored.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidRefreshTokenError('token_expired');
    }

    const session = await this.sessions.findSessionById(stored.sessionId);
    if (session === undefined) {
      throw new InvalidRefreshTokenError('unknown_session');
    }
    if (session.revokedAt !== null) {
      throw new InvalidRefreshTokenError('session_revoked');
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidRefreshTokenError('session_expired');
    }

    const consumed = await this.sessions.consumeRefreshToken(stored.id, now);
    if (consumed === undefined) {
      // Somebody else spent it. Re-read rather than trusting `stored`, which
      // was fetched before the race and may predate the other writer.
      const current = await this.sessions.findRefreshTokenById(stored.id);
      const usedAt = current?.usedAt ?? null;

      if (usedAt === null) {
        // Unreachable in practice: the update matched no row, so `used_at` is
        // set. Treated as a replay rather than assumed impossible, because the
        // safe reading of "I cannot explain this state" on a credential path
        // is the strict one.
        await this.revokeFamilyAfterReuse(session.userId, now);
        throw new InvalidRefreshTokenError('reuse_detected');
      }

      if (!this.isWithinReuseGrace(usedAt, now)) {
        await this.revokeFamilyAfterReuse(session.userId, now);
        throw new InvalidRefreshTokenError('reuse_detected');
      }

      // Inside the window: the same client retrying a request whose response
      // it never received. Issuing a second live token in the family is the
      // cost of that, and it is bounded — both die with the family, and the
      // window is seconds.
      this.logger.debug(
        `session ${session.id}: concurrent refresh inside the grace window, issuing a new token`,
      );
    }

    // Roles and status are re-read here, not carried over from the old token.
    // A refresh is where a role granted — or a suspension applied — since
    // sign-in takes effect, and it is the only point before the 15-minute
    // access token expires at which the server gets to decide again.
    const found = await this.users.findByIdWithRoles(session.userId);
    if (found === undefined || found.user.status !== 'active') {
      // The family dies with the request: a suspended user must not be left
      // holding a refresh token that starts working again on its own.
      // Revoked before the throw, so an account suspended mid-session cannot
      // refresh even once more.
      await this.sessions.revokeSession(session.id, 'suspension', now);
      throw new AccountNotActiveError();
    }

    const minted = this.tokens.mintRefreshToken();
    await this.sessions.rotate({
      sessionId: session.id,
      refreshTokenId: minted.id,
      refreshTokenHash: minted.tokenHash,
      // Never recomputed from `now`: the family's absolute end was set at
      // sign-in, and rotation that extended it would make a 30-day session
      // immortal for any client that keeps refreshing.
      expiresAt: session.expiresAt,
      now,
    });

    const access = this.tokens.issueAccessToken(
      { userId: session.userId, sessionId: session.id, roles: found.roles },
      now,
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: minted.token,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  /** Signs this device out. Idempotent — a second call changes nothing. */
  async logout(sessionId: string, now: Date = new Date()): Promise<void> {
    await this.sessions.revokeSession(sessionId, 'logout', now);
  }

  /**
   * Signs every device out, including the one that asked.
   *
   * Deliberately not "every device except this one": a user who reaches for
   * this has usually lost a phone or suspects a compromise, and the answer
   * they want is "all of them". Signing back in on the device in their hand
   * costs one SMS.
   */
  async logoutAll(userId: string, now: Date = new Date()): Promise<number> {
    return this.sessions.revokeAllSessionsForUser(userId, 'logout_all', now);
  }

  /**
   * Revokes every session because an admin suspended the account
   * (`docs/architecture/authentication.md` § Sessions and devices).
   *
   * No endpoint calls this yet — admin actions are EPIC 13. It lives here
   * because suspension's effect on sessions is a property of the session
   * model rather than of the admin panel, and having it defined is what lets
   * that Epic be a controller rather than a design.
   *
   * Belt to the guard's braces: `ActorService` already rejects a non-active
   * user on every request, so suspension takes effect immediately even if this
   * is never called. What this adds is that the refresh token stops working
   * too, instead of waiting out the family's thirty days.
   */
  async revokeAllForSuspension(userId: string, now: Date = new Date()): Promise<number> {
    return this.sessions.revokeAllSessionsForUser(userId, 'suspension', now);
  }

  /**
   * The user's live devices, so "sign out on that other phone" is something
   * they can see before they do it.
   *
   * `isCurrent` is computed against the caller's own session id: the client
   * needs to know which entry is the phone in their hand, and nothing else on
   * the row says so.
   */
  async listSessions(
    userId: string,
    currentSessionId: string,
    now: Date = new Date(),
  ): Promise<readonly SessionSummary[]> {
    const rows = await this.sessions.listActiveSessionsForUser(userId, now);
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      isCurrent: row.id === currentSessionId,
    }));
  }

  /**
   * Whether a second presentation of an already-spent token is close enough to
   * the first to be the same client retrying.
   *
   * The window is small and configurable (`REFRESH_REUSE_GRACE_SECONDS`), and
   * it exists because the alternative is worse in the common case: a mobile
   * client that fires a refresh, loses the response to a dropped connection
   * and retries has presented one token twice through nobody's fault. With no
   * window at all that is indistinguishable from theft, and the strict answer
   * signs the user out of every device because their train went into a tunnel.
   */
  private isWithinReuseGrace(usedAt: Date, now: Date): boolean {
    const graceMs = this.config.refreshReuseGraceMs;

    // Zero means the retry path is OFF, which is what `env.schema.ts` and
    // `.env.example` both promise an operator who sets it. A `<=` comparison
    // broke that promise in the one case that matters: an elapsed time of
    // exactly 0 ms is inside a zero-length window, so a replay landing in the
    // same millisecond as the legitimate use was forgiven by a configuration
    // that says it forgives nothing. Checked first and explicitly, rather than
    // left to fall out of the arithmetic below.
    if (graceMs <= 0) {
      return false;
    }

    // `usedAt` is Postgres's `now()` from whichever call won the conditional
    // UPDATE; `now` is this request's own timestamp, taken when it started.
    // Under a genuine race the loser started BEFORE the winner committed, so
    // the difference is legitimately negative — and a negative number is
    // smaller than any window, which made "is this a retry?" answer yes for
    // the right reason by accident and, at a zero window, for no reason at
    // all. Clamped rather than compared raw: a negative elapsed time means the
    // two calls overlapped, which is precisely the concurrent-retry case this
    // window exists to serve, and saying so costs nothing while leaving the
    // decision deterministic instead of a function of which clock was read
    // first. Small database/app clock skew lands in the same branch, bounded
    // by the same window.
    const elapsedMs = Math.max(0, now.getTime() - usedAt.getTime());
    return elapsedMs < graceMs;
  }

  /**
   * A spent token was presented outside the grace window: two parties hold it,
   * and one of them is not the user.
   *
   * **Every session for that user is revoked, not merely this family.** The
   * narrower reading — revoke one family — is what the diagram in
   * `authentication.md` draws, and issue #26's acceptance criterion is
   * explicitly the wider one: "replaying a spent refresh token revokes every
   * session for that user". The wider rule is the right call for this product.
   * A thief who captured one refresh token very likely captured whatever else
   * was on that device, and the cost of being wrong is one SMS per device.
   *
   * Logged as a security event with the user id and the count — never the
   * token — because this is the line an operator investigates, and "reuse
   * detected" on its own tells them nothing they can act on.
   */
  private async revokeFamilyAfterReuse(userId: string, now: Date): Promise<void> {
    const revoked = await this.sessions.revokeAllSessionsForUser(userId, 'reuse_detected', now);
    this.logger.warn(
      `refresh token reuse detected for user ${userId}: revoked ${String(revoked)} session(s)`,
    );
  }
}
