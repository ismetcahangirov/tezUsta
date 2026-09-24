import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { requestLogContext } from '../../common/request-context/request-context';
import { isPublicAdminRoute } from '../admin/admin-public.decorator';
import { isAdminRequest } from '../admin/admin.types';
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
    // A global guard is asked about every execution context, not only HTTP
    // ones — and since issue #166 the process also has a WebSocket gateway.
    // `switchToHttp().getRequest()` on a socket context yields the socket,
    // which has no `headers`, so every line below would read the wrong object.
    //
    // #167 added the message handlers this comment anticipated, and the
    // decision it asked for is made below rather than by widening this to a
    // pass. A socket is authenticated once, at the upgrade, by
    // `SocketAuthenticator` — which is *stronger* than a per-message check,
    // because it refuses before the connection exists rather than after — and
    // the result is on `socket.data.actor`. So the rule here is not "sockets
    // are exempt" but "a socket must already carry the actor that middleware
    // put there"; one that does not is refused exactly as an HTTP request with
    // no bearer token is.
    //
    // Structurally typed rather than imported. `modules/realtime` imports this
    // module for `TokenService` and `ActorService`, so naming its socket type
    // here would close a cycle (CLAUDE.md §14) for a single property read.
    if (context.getType() !== 'http') {
      return this.hasAuthenticatedSocket(context);
    }

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();

    // The admin surface belongs to `AdminAuthenticationGuard`, registered
    // ahead of this one in `app.module.ts`. Falling through to here would be
    // worse than redundant: a consumer access token would authenticate
    // against an admin route, and with no `@Roles()` on an admin handler
    // `RolesGuard` would pass it.
    //
    // The `undefined` branch is the fail-closed half. If the admin guard were
    // ever unregistered, dropped from the provider list, or ordered after this
    // one, skipping unconditionally would leave every `/admin` route open to
    // anyone at all. Requiring the actor it should have set turns that mistake
    // into a 401 on the whole admin surface — loud, and immediately obvious —
    // instead of silence.
    if (isAdminRequest(request)) {
      // The one exception the admin guard itself makes: a handler reached
      // before any admin session exists, which authenticates its own caller.
      if (isPublicAdminRoute(this.reflector, context)) {
        return true;
      }
      if (request.adminActor === undefined) {
        throw new InvalidAccessTokenError('admin_guard_did_not_run');
      }
      return true;
    }

    // No `ensureRequestId` call here any more. It used to be necessary because
    // guards run ahead of interceptors, so a 401 thrown below short-circuited
    // the interceptor that assigned the id and was answered without one.
    // `RequestIdHook` now fills Fastify's `onRequest` slot, which runs before
    // routing — and therefore before this guard — so `request.requestId` is
    // already set on every request that reaches here (issue #47).

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

  /**
   * Whether a non-HTTP execution context is a socket that has already
   * authenticated (issue #167).
   *
   * **The only non-HTTP context this application has is a WebSocket one**, and
   * anything else reaching a global guard is a surface nobody reasoned about —
   * so it is refused rather than allowed to inherit this branch.
   *
   * It re-reads nothing. `SocketAuthenticator` resolved the actor from the
   * database at the upgrade and `RealtimeGateway` closes the socket at the
   * token's `exp`, which is what bounds how stale that snapshot can get
   * (`realtime.types.ts`). Authorization decisions taken from a socket message
   * re-read current state themselves — `RoomAuthorizer` does exactly that on
   * every join — and this guard's job here is the same one it has on HTTP:
   * establish that somebody proved who they are, not what they may do.
   */
  private hasAuthenticatedSocket(context: ExecutionContext): boolean {
    if (context.getType() !== 'ws') {
      throw new InvalidAccessTokenError('unsupported_execution_context');
    }

    const client = context.switchToWs().getClient<{ data?: { actor?: unknown } }>();

    if (client.data?.actor === undefined) {
      throw new InvalidAccessTokenError('missing_credentials');
    }

    return true;
  }
}
