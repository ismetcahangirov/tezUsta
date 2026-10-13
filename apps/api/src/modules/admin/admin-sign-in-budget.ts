import { Inject, Injectable, Logger } from '@nestjs/common';

import { RateLimitedError } from '../../common/errors/rate-limited.error';
import type { RateLimitConfig } from '../../infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../../infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../../infra/rate-limit/rate-limiter.service';

/**
 * The per-account sign-in lockout (ADR-0043 § 4), spent from outside the
 * sign-in route (#329, ADR-0051).
 *
 * The sign-in form spends it through `@RateLimit`, keyed by the lower-cased
 * email (`adminEmailIdentifier`). A password change and a password-reset link
 * both check an admin's credentials too, so they spend the **same** counter:
 * a guess anywhere counts toward one lockout, and no form guesses faster than
 * the sign-in form allows.
 */
@Injectable()
export class AdminSignInBudget {
  private readonly logger = new Logger(AdminSignInBudget.name);

  constructor(
    private readonly limiter: RateLimiterService,
    @Inject(RATE_LIMIT_CONFIG) private readonly rateLimits: RateLimitConfig,
  ) {}

  /** One attempt for `email`. Throws `RateLimitedError` once the account is locked. */
  async spend(email: string, context: string): Promise<void> {
    const policy = this.rateLimits.policies['admin-sign-in'];
    const decision = await this.limiter.consume({
      scope: 'admin-sign-in',
      dimension: 'identifier',
      // Keyed exactly as `adminEmailIdentifier` keys the sign-in form.
      subject: email.trim().toLowerCase(),
      limit: policy.perIdentifier,
      windowMs: policy.windowMs,
      backoffCeilingMs: policy.backoffCeilingMs,
    });
    if (!decision.allowed) {
      this.logger.warn(
        `admin ${context} rate-limited: subject=${decision.subjectDigest} retryAfter=${String(decision.retryAfterSeconds)}s`,
      );
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
  }
}
