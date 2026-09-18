import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { requestLogContext } from '../../common/request-context/request-context';
import { AdminActorService } from './admin-actor.service';
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
 *
 * Like its consumer counterpart it answers "who is this, currently" and
 * nothing more. It does not decide what the admin may do; today every admin
 * may do everything, and EPIC 13 adds the permission model (ADR-0014).
 */
@Injectable()
export class AdminAuthenticationGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthenticationGuard.name);

  constructor(
    private readonly tokens: AdminTokenService,
    private readonly actors: AdminActorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (!isAdminRequest(request)) {
      return true;
    }

    try {
      const claims = this.tokens.verifyAccessToken(this.readBearerToken(request));
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

  private readBearerToken(request: FastifyRequest): string {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length === 0) {
      throw new InvalidAdminTokenError('missing_credentials');
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
