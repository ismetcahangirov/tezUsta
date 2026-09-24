import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { AdminMe, AdminSetupStart } from '@tezusta/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { AdminAuthConfig } from './admin.config';
import { ADMIN_CONFIG } from './admin.types';
import {
  adminEmailIdentifier,
  adminSetupCompleteSchema,
  adminSetupStartSchema,
  adminSignInSchema,
  refreshCookieIdentifier,
  setupTokenIdentifier,
} from './admin-auth.schema';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  clearedAdminCookies,
  hasAdminCsrfHeader,
  readCookie,
  serializeCookie,
} from './admin-cookies';
import { PublicAdminRoute } from './admin-public.decorator';
import { AdminSetupService } from './admin-setup.service';
import type { AdminSessionGrant } from './admin-sign-in.service';
import { AdminSignInFailedError, AdminSignInService } from './admin-sign-in.service';

class AdminSetupStartDto extends createZodDto(adminSetupStartSchema) {}
class AdminSetupCompleteDto extends createZodDto(adminSetupCompleteSchema) {}
class AdminSignInDto extends createZodDto(adminSignInSchema) {}

/**
 * The CSRF wall for the cookie routes (ADR-0043 § 4). A 403 rather than the
 * sign-in 401: it is not a credential failure, it is a request the panel
 * would never have sent.
 */
function requireCsrfHeader(request: FastifyRequest): void {
  if (!hasAdminCsrfHeader(request)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'This request is missing a required header.', 403);
  }
}

/**
 * The admin credential surface (ADR-0043 § 3–4): the routes an admin reaches
 * **before** holding a session. Each is `@PublicAdminRoute()` — skipping the
 * admin guards and nothing else — authenticates its own caller, and carries
 * its own rate limit.
 */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly setup: AdminSetupService,
    private readonly signInService: AdminSignInService,
    @Inject(ADMIN_CONFIG) private readonly config: AdminAuthConfig,
  ) {}

  /** Checks a setup link and offers an authenticator secret. Writes nothing. */
  @PublicAdminRoute()
  @RateLimit({ policy: 'admin-setup', identifier: setupTokenIdentifier })
  @HttpCode(200)
  @Post('setup/start')
  start(@Body() body: AdminSetupStartDto): Promise<AdminSetupStart> {
    return this.setup.start(body.token);
  }

  /** Sets the password and proves the authenticator; spends the link. */
  @PublicAdminRoute()
  @RateLimit({ policy: 'admin-setup', identifier: setupTokenIdentifier })
  @HttpCode(204)
  @Post('setup/complete')
  async complete(@Body() body: AdminSetupCompleteDto): Promise<void> {
    await this.setup.complete(body);
  }

  /**
   * Email + password + code in one request (ADR-0043 § 4) — no
   * half-authenticated state to store, and one 401 whatever was wrong.
   */
  @PublicAdminRoute()
  @RateLimit({ policy: 'admin-sign-in', identifier: adminEmailIdentifier })
  @HttpCode(200)
  @Post('sign-in')
  async signIn(
    @Body() body: AdminSignInDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminMe> {
    requireCsrfHeader(request);
    const grant = await this.signInService.signIn(body);
    this.setSessionCookies(reply, grant);
    return grant.me;
  }

  /**
   * Rotates the refresh cookie. An answer with no `Set-Cookie` means another
   * tab rotated a moment ago and the shared cookie jar already holds the
   * result — the panel just retries what it was doing.
   */
  @PublicAdminRoute()
  @RateLimit({ policy: 'refresh', identifier: refreshCookieIdentifier })
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminMe> {
    requireCsrfHeader(request);
    const token = readCookie(request, ADMIN_REFRESH_COOKIE);
    if (token === undefined) {
      throw new AdminSignInFailedError('no_refresh_cookie');
    }
    try {
      const outcome = await this.signInService.refresh(token);
      if (outcome.kind === 'concurrent') {
        return outcome.me;
      }
      this.setSessionCookies(reply, outcome.grant);
      return outcome.grant.me;
    } catch (error: unknown) {
      if (error instanceof AdminSignInFailedError) {
        void reply.header('set-cookie', clearedAdminCookies(this.config.cookieSecure));
      }
      throw error;
    }
  }

  /** Ends this browser's session and clears both cookies. Always 204. */
  @PublicAdminRoute()
  @HttpCode(204)
  @Post('sign-out')
  async signOut(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    requireCsrfHeader(request);
    await this.signInService.signOut(readCookie(request, ADMIN_REFRESH_COOKIE));
    void reply.header('set-cookie', clearedAdminCookies(this.config.cookieSecure));
  }

  private setSessionCookies(reply: FastifyReply, grant: AdminSessionGrant): void {
    const now = Date.now();
    void reply.header('set-cookie', [
      serializeCookie(ADMIN_ACCESS_COOKIE, grant.accessToken, {
        maxAgeSeconds: (grant.accessExpiresAt.getTime() - now) / 1000,
        secure: this.config.cookieSecure,
      }),
      serializeCookie(ADMIN_REFRESH_COOKIE, grant.refreshToken, {
        maxAgeSeconds: (grant.sessionExpiresAt.getTime() - now) / 1000,
        secure: this.config.cookieSecure,
      }),
    ]);
  }
}
