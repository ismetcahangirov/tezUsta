import { createHash } from 'node:crypto';

import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { WebSession } from '@tezusta/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { readCookie, serializeCookie } from '../../common/http/cookies';
import {
  WEB_ACCESS_COOKIE,
  WEB_REFRESH_COOKIE,
  hasWebCsrfHeader,
} from '../../common/http/web-session-cookies';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { TokenPair } from './auth.types';
import type { OtpRequestAccepted } from './otp.service';
import { OtpService } from './otp.service';
import { OtpRequestDto, OtpVerifyDto, otpEmailIdentifier } from './otp.schema';
import { Public } from './public.decorator';
import { InvalidRefreshTokenError, SessionsService } from './sessions.service';
import { TokenService } from './token.service';

const USER_AGENT_MAX = 512;

/**
 * Every request here that sets, uses or clears a session cookie carries the
 * web CSRF header (ADR-0061 § 2). Sign-in included: a forged sign-in would
 * put the victim's browser in the attacker's session.
 */
function requireCsrfHeader(request: FastifyRequest): void {
  if (!hasWebCsrfHeader(request)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'This request is missing a required header.', 403);
  }
}

/**
 * The refresh budget's key: a hash of the refresh cookie, so one stolen
 * cookie hammering refresh spends its own budget, as `refreshCookieIdentifier`
 * does for the admin panel.
 */
function webRefreshCookieIdentifier(request: FastifyRequest): string | undefined {
  const value = readCookie(request, WEB_REFRESH_COOKIE);
  return value === undefined ? undefined : createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The master's web subscription page's sign-in
 * ([ADR-0061](docs/decisions/ADR-0061-master-web-subscription-page.md) § 2).
 *
 * **The same code path as the app's, not a second one.** The code request and
 * the code check are `OtpService`'s, under the same `otp-request` and
 * `sign-in` rate-limit policies, so every bucket and cap of #390 is shared.
 * What differs is what a verified code opens: a `web` session, whose tokens
 * carry the `tezusta-web` audience, live in httpOnly cookies, and reach only
 * the routes marked `@WebSurface()`. Only active masters are ever texted, and
 * no account is ever created here (§ 4).
 */
@Public()
@Controller('web/auth')
export class WebAuthController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly otp: OtpService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cookieSecure = config.runtime.nodeEnv !== 'development';
  }

  /** The same answer for every address; a code only for an active master's. */
  @Post('otp/request')
  @HttpCode(200)
  @RateLimit({ policy: 'otp-request', identifier: otpEmailIdentifier })
  requestCode(@Body() body: OtpRequestDto): Promise<OtpRequestAccepted> {
    return this.otp.requestForWebMaster({ email: body.email });
  }

  @Post('otp/verify')
  @HttpCode(200)
  @RateLimit({ policy: 'sign-in', identifier: otpEmailIdentifier })
  async verifyCode(
    @Body() body: OtpVerifyDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WebSession> {
    requireCsrfHeader(request);
    const userAgent = request.headers['user-agent'];

    const pair = await this.otp.verifyForWebMaster({
      email: body.email,
      code: body.code,
      device: {
        ...(body.deviceId !== undefined ? { deviceId: body.deviceId } : {}),
        ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, USER_AGENT_MAX) } : {}),
      },
    });

    this.setSessionCookies(reply, pair);
    return { sessionExpiresAt: pair.refreshTokenExpiresAt.toISOString() };
  }

  /**
   * Rotates the web session's refresh cookie. A refusal clears both cookies,
   * so a dead session never lingers in the browser. A refresh token from an
   * app session is refused here (`wrong_surface`), and a web one at
   * `/auth/refresh`.
   */
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ policy: 'refresh', identifier: webRefreshCookieIdentifier })
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WebSession> {
    requireCsrfHeader(request);
    const token = readCookie(request, WEB_REFRESH_COOKIE);
    if (token === undefined) {
      throw new InvalidRefreshTokenError('malformed');
    }
    try {
      const pair = await this.sessions.refresh(token, new Date(), 'web');
      this.setSessionCookies(reply, pair);
      return { sessionExpiresAt: pair.refreshTokenExpiresAt.toISOString() };
    } catch (error: unknown) {
      void reply.header('set-cookie', this.clearedCookies());
      throw error;
    }
  }

  /**
   * Ends the web session the cookie names, if it is a live one, and clears
   * both cookies either way. 204 whatever the cookie said, so sign-out never
   * tells a caller whether a session existed.
   */
  @Post('sign-out')
  @HttpCode(204)
  async signOut(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    requireCsrfHeader(request);
    // The refresh cookie names the session for as long as it lives; the access
    // cookie may already have expired, so it is only the fallback.
    const refresh = readCookie(request, WEB_REFRESH_COOKIE);
    const access = readCookie(request, WEB_ACCESS_COOKIE);
    if (refresh !== undefined) {
      await this.sessions.logoutByRefreshToken(refresh, 'web');
    } else if (access !== undefined) {
      const sessionId = this.webSessionId(access);
      if (sessionId !== undefined) {
        await this.sessions.logout(sessionId);
      }
    }
    void reply.header('set-cookie', this.clearedCookies());
  }

  /** The session a still-valid web access token names, or `undefined`. */
  private webSessionId(token: string): string | undefined {
    try {
      return this.tokens.verifyAccessToken(token, new Date(), 'web').sid;
    } catch {
      return undefined;
    }
  }

  private setSessionCookies(reply: FastifyReply, pair: TokenPair): void {
    const now = Date.now();
    void reply.header('set-cookie', [
      serializeCookie(WEB_ACCESS_COOKIE, pair.accessToken, {
        maxAgeSeconds: (pair.accessTokenExpiresAt.getTime() - now) / 1000,
        secure: this.cookieSecure,
      }),
      serializeCookie(WEB_REFRESH_COOKIE, pair.refreshToken, {
        maxAgeSeconds: (pair.refreshTokenExpiresAt.getTime() - now) / 1000,
        secure: this.cookieSecure,
      }),
    ]);
  }

  private clearedCookies(): string[] {
    return [
      serializeCookie(WEB_ACCESS_COOKIE, '', { maxAgeSeconds: 0, secure: this.cookieSecure }),
      serializeCookie(WEB_REFRESH_COOKIE, '', { maxAgeSeconds: 0, secure: this.cookieSecure }),
    ];
  }
}
