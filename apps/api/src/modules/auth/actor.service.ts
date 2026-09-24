import { Injectable } from '@nestjs/common';

import { UsersRepository } from '../users/users.repository';
import type { AccessTokenClaims, Actor } from './auth.types';
import { SessionsRepository } from './sessions.repository';
import { InvalidAccessTokenError } from './token.service';

/**
 * Turns a set of **verified** token claims into the actor the request is
 * actually allowed to act as — by going back to the database for both halves.
 *
 * This service is the whole content of the sentence
 * `docs/architecture/authentication.md` builds authorization on: *a role claim
 * in a token is a cache, not an authority*. `TokenService.verifyAccessToken`
 * proves a token is ours, unexpired and untampered; that is a statement about a
 * string, and nothing more. Between the moment the token was minted and the
 * moment it arrives, an admin may have suspended the account, the user may have
 * been soft-deleted, the role grant may have been withdrawn, and the device
 * session may have been signed out from another phone. None of those events can
 * reach into a token that is already in an attacker's hands, so every one of
 * them is checked here, on every request, against current state.
 *
 * The cost is two primary-key lookups on the hottest path in the API. That is
 * the price of the guarantee and it is not negotiable down to "trust the claim
 * and re-check on writes only": the read paths are where a suspended master
 * would otherwise keep seeing customers' home addresses.
 */
@Injectable()
export class ActorService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * Resolves the claims, or throws {@link InvalidAccessTokenError} — the single
   * uniform 401, carrying the specific reason on a property the response
   * envelope never sees.
   *
   * Every rejection below is an authentication failure rather than a 403, on
   * purpose. A 403 would tell the holder of a stolen token *which* of "your
   * session was signed out", "this account is suspended" and "this user no
   * longer exists" applies, and each of those is a fact about an account they
   * may not own. It is also the answer that makes the mobile client behave: a
   * 401 sends it to the refresh endpoint, which refuses a suspended account
   * too, and from there to the sign-in screen — where
   * {@link AccountNotActiveError}'s 403 is the right place to say plainly that
   * the account is not active, because by then the caller has proven the phone
   * number is theirs.
   */
  async resolve(claims: AccessTokenClaims, now: Date = new Date()): Promise<Actor> {
    return this.resolveSession(claims.sub, claims.sid, now);
  }

  /**
   * Re-resolves an actor that was resolved earlier — **the same checks, against
   * the database as it is now**, for a caller holding a snapshot rather than a
   * token.
   *
   * The socket is that caller (issue #185). `socket.data.actor` is resolved
   * once, at the handshake, and then frozen until the access token's `exp`
   * closes the socket (`realtime.types.ts`). That bound is fine for hearing a
   * room; it is not fine for **acting** — placing a call rings another
   * person's phone, and accepting one mints a media credential. So a frame
   * that acts re-asks here, and a session signed out or an account suspended a
   * minute ago is refused a minute ago rather than at the next reconnect.
   *
   * @throws {InvalidAccessTokenError} for exactly the reasons {@link resolve} does.
   */
  async current(actor: Actor, now: Date = new Date()): Promise<Actor> {
    return this.resolveSession(actor.userId, actor.sessionId, now);
  }

  private async resolveSession(userId: string, sessionId: string, now: Date): Promise<Actor> {
    // Issued together rather than awaited in sequence. The two reads are
    // independent — one keyed by `sid`, one by `sub` — so serialising them
    // would add a full round trip to every authenticated request for no
    // ordering guarantee. The checks below still run in a fixed order, so which
    // reason is logged is deterministic regardless of which query returned
    // first.
    const [session, found] = await Promise.all([
      this.sessions.findSessionById(sessionId),
      this.users.findByIdWithRoles(userId),
    ]);

    if (session === undefined) {
      throw new InvalidAccessTokenError('unknown_session');
    }
    // A token whose `sub` and `sid` disagree cannot have been minted by
    // `SessionsService`, which sets both from the same sign-in. Reaching this
    // line means either the signing secret has leaked or a session id was
    // guessed onto a forged claim set; both are refusals, and pinning the
    // session to its user is also what stops a stolen `sid` from being pointed
    // at a different — possibly more privileged — account.
    if (session.userId !== userId) {
      throw new InvalidAccessTokenError('session_user_mismatch');
    }
    if (session.revokedAt !== null) {
      throw new InvalidAccessTokenError('session_revoked');
    }
    // The family's absolute end, set at sign-in from `JWT_REFRESH_TTL` and
    // never extended by rotation. An access token cannot outlive it: the
    // 15-minute window is short enough that this only bites at the boundary,
    // and letting it through there would quietly turn a 30-day session into a
    // 30-day-and-15-minute one.
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidAccessTokenError('session_expired');
    }

    if (found === undefined) {
      // `findByIdWithRoles` filters `deleted_at IS NULL`, so a soft-deleted
      // account is absent here rather than present-and-deleted. That is the
      // intended reading: to every caller, a deleted user does not exist.
      throw new InvalidAccessTokenError('unknown_user');
    }
    if (found.user.status !== 'active') {
      throw new InvalidAccessTokenError('account_not_active');
    }

    return {
      userId: found.user.id,
      sessionId: session.id,
      // From `user_roles`, never from `claims.roles`. This is the line the
      // whole service exists for: a token minted before a master's grant was
      // withdrawn still carries `master`, and reading the claim here would make
      // every downstream role check a check against that stale copy.
      roles: found.roles,
      status: found.user.status,
    };
  }
}
