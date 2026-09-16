import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ensureRequestId, requestLogContext } from '../../common/request-context/request-context';
import { ActorService } from './actor.service';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import { InvalidAccessTokenError, TokenService } from './token.service';

/** RFC 7235 §2.1: the auth-scheme token is case-insensitive. */
const BEARER_SCHEME = 'bearer';

/**
 * Authentication for every route in the application.
 *
 * Registered as an `APP_GUARD` in `AppModule`, which is what makes the API
 * **secure by default**: the guard is asked about every request, and a route
 * that says nothing is protected. Opting out is an explicit `@Public()` on the
 * route (see that decorator for why the inverse design is the unsafe one).
 *
 * What it does *not* do is decide whether the caller may perform the operation.
 * It answers "who is this, currently" and attaches the answer;
 * `RolesGuard` and `requireVisibleOrNotFound` answer the rest
 * (`docs/architecture/authentication.md` § Authorization, three layers).
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly logger = new Logger(AuthenticationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly actors: ActorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();

    // Before anything can be rejected. Guards run ahead of interceptors, so
    // without this the 401s below would be logged and answered with no request
    // id at all — see `ensureRequestId`.
    ensureRequestId(request, http.getResponse<FastifyReply>());

    // `getAllAndOverride` so a method-level decorator wins over its controller,
    // in that order. The route's own statement is the more specific one and has
    // to be the one that counts.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    try {
      const claims = this.tokens.verifyAccessToken(this.readBearerToken(request));
      request.actor = await this.actors.resolve(claims);
      return true;
    } catch (error: unknown) {
      if (error instanceof InvalidAccessTokenError) {
        // The **only** place the reason is recorded, and it goes to the server
        // log beside the request id — never into the response, which carries
        // one message for every cause (issue #27: guards must not leak which
        // check failed). A client that can tell `expired` from `bad_signature`
        // from `session_revoked` holds an oracle; an operator reading this line
        // needs exactly that distinction to answer "why was I signed out?".
        //
        // `error.reason` is a fixed vocabulary of our own words — no part of
        // the token, the header, or the phone number reaches this line
        // (CLAUDE.md §11), which `auth.guards.e2e.test.ts` asserts by spying on
        // every log sink.
        this.logger.warn(`${requestLogContext(request)} authentication rejected: ${error.reason}`);
      }
      throw error;
    }
  }

  /**
   * Extracts the bearer token, or throws the same 401 everything else here
   * throws.
   *
   * Strict about the header's shape rather than forgiving: `Bearer a b` and a
   * bare token with no scheme are both malformed, and accepting either would
   * mean the string that eventually reaches signature verification is not the
   * one the client believes it sent.
   */
  private readBearerToken(request: FastifyRequest): string {
    const header = request.headers.authorization;
    if (header === undefined) {
      throw new InvalidAccessTokenError('missing_credentials');
    }

    const parts = header.split(' ');
    const [scheme, token] = parts;
    if (
      parts.length !== 2 ||
      scheme?.toLowerCase() !== BEARER_SCHEME ||
      token === undefined ||
      token.length === 0
    ) {
      throw new InvalidAccessTokenError('malformed_authorization_header');
    }

    return token;
  }
}
