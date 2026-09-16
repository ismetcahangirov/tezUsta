import { createHmac } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { maskPhone } from '../../infra/phone/azerbaijani-phone';
import { RateLimiterService } from '../../infra/rate-limit/rate-limiter.service';
import type { SmsSender } from '../../infra/sms/sms-sender.types';
import { SMS_SENDER } from '../../infra/sms/sms-sender.types';
import { UsersRepository } from '../users/users.repository';
import type { DeviceInfo, TokenPair } from './auth.types';
import { generateOtpCode, renderOtpMessage } from './otp-code';
import type { OtpConfig } from './otp.config';
import { OtpRepository } from './otp.repository';
import { OTP_CONFIG } from './otp.tokens';
import { SessionsService } from './sessions.service';

/**
 * The scope the per-code attempt cap is counted under in Redis. Keyed by the
 * **challenge id**, not by the phone number, so requesting a new code starts a
 * fresh budget — an attacker cannot burn one code's attempts to lock out the
 * next, and a user who fat-fingered five times clears it by asking again
 * (`infra/rate-limit/rate-limit.types.ts` § AttemptRequest).
 */
const ATTEMPT_SCOPE = 'otp-verify';

/**
 * The single answer every verification failure gets.
 *
 * Wrong code, expired code, already redeemed, attempt cap spent, no code ever
 * requested for that number, and "that number has no account" are one status,
 * one code and one message. Each distinction that leaked would be an oracle:
 * "expired" versus "wrong" tells an attacker their guess was correct but late,
 * and "no such challenge" versus "wrong code" answers *"has this number
 * requested a code?"* to anyone who asks (ADR-0008 § Security requirements).
 */
class InvalidOtpError extends AppError {
  constructor() {
    super(ERROR_CODES.UNAUTHORIZED, 'The code is invalid or has expired.', 401);
    this.name = 'InvalidOtpError';
    Object.setPrototypeOf(this, InvalidOtpError.prototype);
  }
}

/**
 * The code was written but the provider would not take it.
 *
 * A distinct failure from "the request was bad", and it must stay distinct in
 * the server's own reasoning: this is the shape of a launch-blocking outage
 * (an expired SMS account, a sender ID revoked by an operator) and it should
 * page somebody, not read as user error. To the caller it says only that the
 * code could not be sent, which is true regardless of whether the number
 * belongs to an account.
 */
class OtpDeliveryFailedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.INTERNAL_ERROR,
      'The code could not be sent right now. Please try again shortly.',
      503,
    );
    this.name = 'OtpDeliveryFailedError';
    Object.setPrototypeOf(this, OtpDeliveryFailedError.prototype);
  }
}

/** A request for a code. The number is already normalised by the Zod schema. */
export interface RequestOtpInput {
  readonly phoneE164: string;
}

/**
 * What the request endpoint answers with — and the shape is part of the
 * security design, not a convenience.
 *
 * It carries the configured TTL and **nothing derived from the caller**: no
 * challenge id, no "a code was already sent", no account state. Two requests,
 * one for a number with an account and one for a number without, must produce
 * the same bytes; a field that could differ between them is the enumeration
 * oracle ADR-0008 forbids, however useful it would be to a client.
 */
export interface OtpRequestAccepted {
  readonly expiresInSeconds: number;
}

export interface VerifyOtpInput {
  readonly phoneE164: string;
  readonly code: string;
  readonly device?: DeviceInfo | undefined;
}

/**
 * Sign-in for customers and masters: issue a code, prove the number, open a
 * session (ADR-0008 — there is no other consumer sign-in path).
 *
 * **Which SMS provider delivers the code is still an open decision**
 * (CLAUDE.md §1) and is the single highest-priority launch blocker. Everything
 * in this file works against the {@link SmsSender} interface, so the choice is
 * one new file in `infra/sms/` and one enum member — but until it is made,
 * nobody can actually sign in, because the only sender that exists refuses to
 * construct outside development.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly challenges: OtpRepository,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly limiter: RateLimiterService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(OTP_CONFIG) private readonly config: OtpConfig,
  ) {}

  /**
   * Issues a code and sends it, whether or not the number has an account.
   *
   * **The absence of a `users` lookup in this method is the feature.** The
   * obvious implementation — find the user, create one if missing, then send —
   * would make this endpoint both an account-creation endpoint that anyone can
   * fire at any number in Azerbaijan and an enumeration oracle, because a
   * "create" path and a "found" path never cost the same. Identity is decided
   * at verification, by which point the caller has proven they hold the
   * number. So the two cases here are not merely answered identically; they
   * execute the same statements.
   *
   * The order — write, then send — is the only safe one. Sending first risks a
   * code in somebody's hand that no row will ever match, which reads to the
   * user as a service that lies about sending codes; writing first risks at
   * worst a live row nobody can use, which the next request supersedes.
   */
  async request(input: RequestOtpInput, now: Date = new Date()): Promise<OtpRequestAccepted> {
    const id = uuidV7();
    const code = generateOtpCode(this.config.length);
    const expiresAt = new Date(now.getTime() + this.config.ttlMs);

    await this.challenges.replaceLiveChallenge(
      { id, phoneE164: input.phoneE164, codeHash: this.hashCode(id, code), expiresAt },
      now,
    );

    await this.deliver(input.phoneE164, code);

    // The audit line for "a code was sent". Masked number and challenge id
    // only: `docs/engineering/security.md` forbids a full phone number in a
    // log, and the code itself may not appear in one at all (ADR-0008), which
    // is why `code` is not interpolated here and must never be added.
    this.logger.log(
      `otp code issued: challenge=${id} phone=${maskPhone(input.phoneE164)} ` +
        `expiresIn=${String(this.ttlSeconds())}s`,
    );

    return { expiresInSeconds: this.ttlSeconds() };
  }

  /**
   * Verifies a code and signs the caller in.
   *
   * The order of the steps is the security-relevant part:
   *
   * 1. Find the one live challenge for the number. No challenge is the same
   *    failure as a wrong code.
   * 2. **Count the attempt before checking the code.** A guess that is
   *    evaluated before it is counted is a guess an attacker can make for free
   *    by disconnecting, and the cap would bound nothing.
   * 3. Redeem it with one conditional `UPDATE`, which is what makes concurrent
   *    redemption of one code impossible rather than unlikely.
   * 4. Only then touch identity: find or create the account, and open a
   *    session.
   *
   * The account is created with **no role grant**. A user who has proven their
   * number exists and can authenticate; whether they are a customer, a master,
   * or both is a separate choice on a separate endpoint, and
   * `users.repository.ts` already documents the role-less user as a real state
   * rather than an anomaly.
   */
  async verify(input: VerifyOtpInput, now: Date = new Date()): Promise<TokenPair> {
    const challenge = await this.challenges.findLiveByPhone(input.phoneE164, now);
    if (challenge === undefined) {
      throw new InvalidOtpError();
    }

    const tally = await this.limiter.consumeAttempt({
      scope: ATTEMPT_SCOPE,
      subject: challenge.id,
      maxAttempts: this.config.maxAttempts,
      // The counter must die exactly when the code does. Longer, and five
      // wrong guesses lock out the *next* code the user asks for; shorter, and
      // the cap silently resets while the code is still redeemable.
      // `Math.max(1, …)` because a challenge that expires in the microseconds
      // between the read above and this call would otherwise ask Redis for a
      // non-positive TTL, which it rejects.
      ttlMs: Math.max(1, challenge.expiresAt.getTime() - now.getTime()),
    });

    if (tally.used > this.config.maxAttempts) {
      // Reachable only if the invalidation below failed after the cap was
      // spent — a lost database connection, say. The code must stay refused,
      // so the Redis counter is treated as authoritative for refusal even
      // though the row is what makes invalidation durable.
      await this.challenges.invalidate(challenge.id, 'attempts_exhausted', now);
      throw new InvalidOtpError();
    }

    const consumed = await this.challenges.consume(
      challenge.id,
      this.hashCode(challenge.id, input.code),
      now,
    );

    if (consumed === undefined) {
      if (tally.exhausted) {
        // ADR-0008: "max 5 attempts per code, then invalidate". The counting
        // is `RateLimiterService`'s; destroying the credential is this
        // module's, because only this module knows what the counter was
        // guarding (`rate-limit.types.ts` says so explicitly).
        await this.challenges.invalidate(challenge.id, 'attempts_exhausted', now);
        this.logger.warn(
          `otp attempt cap reached, challenge invalidated: challenge=${challenge.id} ` +
            `phone=${maskPhone(input.phoneE164)}`,
        );
      }
      throw new InvalidOtpError();
    }

    // The attempt budget belongs to a code that no longer exists. Dropping it
    // keeps a legitimate "two wrong, then right" sign-in from leaving a
    // half-spent counter behind — which would otherwise expire on its own, but
    // only after occupying a key whose whole purpose is now gone.
    await this.limiter.clearAttempts(ATTEMPT_SCOPE, challenge.id);

    const existing = await this.users.findByPhone(input.phoneE164);
    const userId =
      existing?.id ?? (await this.users.create({ phoneE164: input.phoneE164, roles: [] })).user.id;

    this.logger.log(
      `otp verified, session starting: challenge=${challenge.id} ` +
        `phone=${maskPhone(input.phoneE164)} newAccount=${String(existing === undefined)}`,
    );

    return this.sessions.startSession(
      { userId, ...(input.device !== undefined ? { device: input.device } : {}) },
      now,
    );
  }

  /**
   * HMAC-SHA256 of `<challenge id>|<code>`, keyed by `OTP_CODE_PEPPER`.
   *
   * Deterministic and keyed, deliberately, because that is what lets the
   * digest be computed once here and compared inside the same `WHERE` clause
   * that performs the consumption — see `OtpRepository.consume`. A per-row
   * salted KDF would be the reflexive "stronger" choice and would break that
   * atomicity outright, for no gain against a ~20-bit keyspace
   * (`docs/engineering/dependency-policy.md`).
   *
   * Binding the challenge id into the input, rather than only using it as the
   * row key, means two rows carrying the same six digits hash differently — so
   * a dump cannot be grouped by equal digests, and a digest lifted from one
   * row can never be replayed against another.
   *
   * Rotating `OTP_CODE_PEPPER` invalidates every outstanding code, which is
   * the correct behaviour for a suspected leak: the worst it costs a user is
   * asking for a new code.
   */
  private hashCode(challengeId: string, code: string): string {
    return createHmac('sha256', this.config.codePepper)
      .update(`${challengeId}|${code}`)
      .digest('hex');
  }

  /**
   * Hands the message to whichever provider is configured, and lets **nothing**
   * the provider says reach a log.
   *
   * `OutboundSms.body` contains the code, so a provider that includes its
   * request payload in an error — a perfectly ordinary thing for an HTTP
   * client to do — would put that code in the exception message, and the
   * global exception filter logs `error.stack` for every unhandled error.
   * That single hop is how "codes never appear in logs" (ADR-0008) gets broken
   * without anybody writing a log statement at all. The interface already
   * forbids it in words; this catch is what makes the guarantee not depend on
   * a future vendor adapter honouring the comment.
   */
  private async deliver(phoneE164: string, code: string): Promise<void> {
    try {
      await this.sms.send({
        to: phoneE164,
        body: renderOtpMessage(code, Math.round(this.ttlSeconds() / 60)),
      });
    } catch (error: unknown) {
      this.logger.error(
        `sms delivery failed: phone=${maskPhone(phoneE164)} ` +
          `error=${error instanceof Error ? error.name : 'unknown'}`,
      );
      throw new OtpDeliveryFailedError();
    }
  }

  private ttlSeconds(): number {
    return Math.round(this.config.ttlMs / 1000);
  }
}
