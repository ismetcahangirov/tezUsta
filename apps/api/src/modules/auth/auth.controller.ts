import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { refreshRequestSchema } from './auth.schema';
import type { SessionSummary, TokenPair } from './auth.types';
import { CurrentActor } from './current-actor.decorator';
import type { Actor } from './auth.types';
import { Public } from './public.decorator';
import { SessionsService } from './sessions.service';

class RefreshDto extends createZodDto(refreshRequestSchema) {}

/**
 * What a token endpoint returns. `expiresAt` values are ISO strings rather
 * than `Date`s because this crosses the wire; the client uses them to schedule
 * a refresh instead of discovering expiry as a 401 mid-screen. They are a
 * convenience and never the thing the server trusts — the token's own `exp`
 * claim is.
 */
interface TokenPairResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

function toResponse(pair: TokenPair): TokenPairResponse {
  return {
    accessToken: pair.accessToken,
    accessTokenExpiresAt: pair.accessTokenExpiresAt.toISOString(),
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: pair.refreshTokenExpiresAt.toISOString(),
  };
}

/**
 * The public half of the presented refresh token, used as the rate-limit
 * subject.
 *
 * Issue #28's `refresh` policy is documented as "per session", and the id half
 * of a refresh token is the closest thing a request carries *before* anything
 * has been looked up — the guard runs before any database read, by design.
 *
 * The effect is the one that matters: rotation issues a new id every time, so
 * a legitimate client never spends the same bucket twice and is never limited,
 * while an attacker replaying **one** captured token is limited immediately.
 * That is the traffic the limit exists for. Returning `undefined` for a
 * malformed body is deliberate — the per-IP dimension still applies, so an
 * unparseable request is never a free one, and rejecting it here would answer
 * 429 for what is really a 422.
 */
function refreshTokenIdFrom(request: FastifyRequest): string | undefined {
  const { body } = request;
  if (typeof body !== 'object' || body === null || !('refreshToken' in body)) {
    return undefined;
  }
  const value: unknown = (body as Record<string, unknown>).refreshToken;
  if (typeof value !== 'string') {
    return undefined;
  }
  const [id] = value.split('.');
  return id !== undefined && id.length > 0 ? id : undefined;
}

/**
 * Session lifecycle over HTTP: rotate, sign out, sign out everywhere, and see
 * which devices are signed in.
 *
 * **Sign-in is not here.** On the consumer path it is OTP verification
 * (issue #29, ADR-0008), and there is no second sign-in route — "one
 * authentication vector, not two" is a rule this controller must not quietly
 * break by growing one.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly sessions: SessionsService) {}

  /**
   * Rotates the refresh token.
   *
   * `@Public()` because the whole point is that the caller's access token has
   * expired — requiring one would make the endpoint useless exactly when it is
   * needed. It is not unauthenticated: the refresh token *is* the credential,
   * and it is verified against the database on every call, which is what makes
   * revocation real here and impossible at the access-token layer.
   */
  @Public()
  @RateLimit({ policy: 'refresh', identifier: refreshTokenIdFrom })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: RefreshDto): Promise<TokenPairResponse> {
    return toResponse(await this.sessions.refresh(body.refreshToken));
  }

  /**
   * Signs this device out.
   *
   * Takes the session from the **access token's** actor rather than from a
   * refresh token in the body. A caller can only sign out a session they can
   * currently authenticate as, so there is no "sign out someone else's device"
   * shape to get wrong, and no token value travels in a request body that
   * proxies and logs would see.
   *
   * 204: there is nothing useful to return, and a body would invite a client
   * to branch on it.
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor): Promise<void> {
    await this.sessions.logout(actor.sessionId);
  }

  /** Signs every device out, this one included. See `SessionsService.logoutAll`. */
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentActor() actor: Actor): Promise<void> {
    await this.sessions.logoutAll(actor.userId);
  }

  /**
   * The caller's live device sessions.
   *
   * Scoped to `actor.userId`, which is read from the database-resolved actor
   * and never from a path or query parameter — there is deliberately no
   * `GET /auth/sessions/:userId` to get the ownership check wrong on.
   */
  @Get('sessions')
  async list(@CurrentActor() actor: Actor): Promise<readonly SessionSummary[]> {
    return this.sessions.listSessions(actor.userId, actor.sessionId);
  }
}
