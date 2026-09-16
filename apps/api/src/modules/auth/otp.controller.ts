import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import type { TokenPair } from './auth.types';
import type { OtpRequestAccepted } from './otp.service';
import { OtpService } from './otp.service';
import { OtpRequestDto, OtpVerifyDto, otpPhoneIdentifier } from './otp.schema';
import { Public } from './public.decorator';

/** The `sessions.user_agent` column width. An over-long header is cut, not refused. */
const USER_AGENT_MAX = 512;

/**
 * Phone + OTP sign-in — the only sign-in path for customers and masters
 * (ADR-0008).
 *
 * **Both routes are `@Public()` by necessity, and both carry a `@RateLimit`
 * for the same reason.** A caller who already holds a token is not who these
 * exist for, so authentication cannot gate them; that makes them the two most
 * exposed endpoints in the API, and the OTP request in particular spends real
 * money on every allowed call. ADR-0008 § Do not: "do not ship an OTP endpoint
 * without rate limiting, **not even in staging**".
 *
 * Kept in its own controller rather than added to `auth.controller.ts`: sign-in
 * is one concern (prove a number, open a session) and session lifecycle —
 * refresh, logout, device list — is another, and the two have different
 * exposure. Everything here is reachable with no credential at all.
 */
@Public()
@Controller('auth/otp')
export class OtpController {
  constructor(private readonly otp: OtpService) {}

  /**
   * Sends a code to the number, whether or not it has an account.
   *
   * `200`, not Nest's default `201`: nothing addressable was created — the
   * challenge is a server-side credential the caller never sees — and a status
   * that varied with anything would be one more channel that has to stay
   * identical for known and unknown numbers.
   *
   * The identifier for the limit is the **normalised** number, so
   * `+994 50 111 22 33` and `+994501112233` spend one budget rather than two
   * (see `otpPhoneIdentifier`). Both dimensions apply: per number, because
   * that is the SMS bill for one victim's handset, and per IP, because an
   * attacker rotating numbers from one host is the realistic version of the
   * same attack.
   */
  @Post('request')
  @HttpCode(200)
  @RateLimit({ policy: 'otp-request', identifier: otpPhoneIdentifier })
  requestCode(@Body() body: OtpRequestDto): Promise<OtpRequestAccepted> {
    return this.otp.request({ phoneE164: body.phone });
  }

  /**
   * Verifies a code and returns the token pair.
   *
   * Carries the `sign-in` policy because on the consumer path **this endpoint
   * is sign-in** — `docs/architecture/authentication.md` § Rate limiting is
   * explicit that there is no third endpoint to throttle. That limit bounds
   * how often a caller may try at all; the per-code attempt cap inside
   * `OtpService` is what bounds guessing one particular code.
   *
   * The device id comes from the body because only the client knows it, and
   * the user agent from the header because that is where a real client puts
   * it — neither is ever trusted for authorization
   * (`infra/database/schema/sessions.ts`). Both exist so the device list a
   * user sees is readable, and nothing else.
   */
  @Post('verify')
  @HttpCode(200)
  @RateLimit({ policy: 'sign-in', identifier: otpPhoneIdentifier })
  verifyCode(@Body() body: OtpVerifyDto, @Req() request: FastifyRequest): Promise<TokenPair> {
    const userAgent = request.headers['user-agent'];

    return this.otp.verify({
      phoneE164: body.phone,
      code: body.code,
      device: {
        // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
        // optional property explicitly, so each key is only present when the
        // client actually supplied the value.
        ...(body.deviceId !== undefined ? { deviceId: body.deviceId } : {}),
        ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, USER_AGENT_MAX) } : {}),
      },
    });
  }
}
