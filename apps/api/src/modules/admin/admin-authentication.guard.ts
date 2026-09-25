import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { requestLogContext } from '../../common/request-context/request-context';
import { AdminActorService } from './admin-actor.service';
import { ADMIN_ACCESS_COOKIE, hasAdminCsrfHeader, readCookie } from './admin-cookies';
import { isPublicAdminRoute } from './admin-public.decorator';
import { AdminTokenService, InvalidAdminTokenError } from './admin-token.service';
import { isAdminRequest } from './admin.types';

/** RFC 7235 §2.1: the auth-scheme token is case-insensitive. */
const BEARER_SCHEME = 'bearer';

/**
 * Authentication for the **admin surface**, and only for it.
 *
 * Registered as an `APP_GUARD` ahead of the consumer `AuthenticationGuard`.
 * Every request under `/admin` must present an admin access token; every
 * request outside it is passed straight through for the consumer guard to
 * handle.
 *
 * **It keys on the path, not on a decorator**, and `admin.types.ts`
 * § `isAdminRequest` explains why: a forgotten marker would leave an admin
 * route protected by the *consumer* guard, where an ordinary customer's token
 * authenticates and — with no `@Roles()` on the handler — passes. Keying on
 * where the route lives makes a new `/admin` endpoint guarded by construction.
 * "Where it lives" is the route the router matched, not the URL as the client
 * spelled it (#269) — the two can differ, and only the first names the handler.
 *
 * Like its consumer counterpart it answers "who is this, currently" and
 * nothing more. What the admin may do is `AdminPermissionGuard`'s question,
 * asked directly after this one (ADR-0043 § 1).
 */
@Injectable()
export class AdminAuthenticationGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthenticationGuard.name);

  constructor(
    private readonly tokens: AdminTokenService,
    private readonly actors: AdminActorService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // A global guard is asked about every execution context, and since #167
    // socket messages reach one. `switchToHttp()` on a socket yields the
    // socket, which has no `url` — so `isAdminRequest` would answer `false`
    // for the right reason by accident. There is no admin surface on the
    // socket (`room-authorizer.ts`: an admin gets no blanket join), so saying
    // so explicitly is both correct and one less thing reading the wrong
    // object.
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (!isAdminRequest(request)) {
      return true;
    }

    // The setup link and the sign-in form: reached before any session exists,
    // and each authenticates its caller itself (`PublicAdminRoute`).
    if (isPublicAdminRoute(this.reflector, context)) {
      return true;
    }

    try {
      const claims = this.tokens.verifyAccessToken(this.readAccessToken(request));
      request.adminActor = await this.actors.resolve(claims);
      return true;
    } catch (error: unknown) {
      if (error instanceof InvalidAdminTokenError) {
        // The reason is logged, never returned. Every failure is the same 401
        // to the caller — see InvalidAdminTokenError.
        this.logger.warn(
          `${requestLogContext(request)} admin authentication rejected: ${error.reason}`,
        );
      }
      throw error;
    }
  }

  /**
   * The bearer header when there is one — tests and scripts — and otherwise
   * the panel's httpOnly access cookie (ADR-0043 § 4). A cookie is sent by the
   * browser on its own, so it counts only alongside the CSRF header a
   * cross-site page cannot add; a bearer header is never sent on its own and
   * needs no such check.
   */
  private readAccessToken(request: FastifyRequest): string {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length === 0) {
      const cookie = readCookie(request, ADMIN_ACCESS_COOKIE);
      if (cookie === undefined) {
        throw new InvalidAdminTokenError('missing_credentials');
      }
      if (!hasAdminCsrfHeader(request)) {
        throw new InvalidAdminTokenError('cookie_without_csrf_header');
      }
      return cookie;
    }
    const [scheme, ...rest] = header.split(' ');
    if (scheme === undefined || scheme.toLowerCase() !== BEARER_SCHEME || rest.length !== 1) {
      throw new InvalidAdminTokenError('malformed_authorization_header');
    }
    const token = rest[0];
    if (token === undefined || token.length === 0) {
      throw new InvalidAdminTokenError('malformed_authorization_header');
    }
    return token;
  }
}
