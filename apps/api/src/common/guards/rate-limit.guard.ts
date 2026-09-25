import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import type { RateLimitConfig } from '../../infra/rate-limit/rate-limit.config';
import {
  ACCESS_TOKEN_SUBJECT_VERIFIER,
  RATE_LIMIT_CONFIG,
} from '../../infra/rate-limit/rate-limit.tokens';
import type {
  AccessTokenSubjectVerifier,
  RateLimitDecision,
  RateLimitRequest,
} from '../../infra/rate-limit/rate-limit.types';
import { RateLimiterService } from '../../infra/rate-limit/rate-limiter.service';
import type { RateLimitOptions } from '../decorators/rate-limit.decorator';
import { RATE_LIMIT_METADATA } from '../decorators/rate-limit.decorator';
import { RateLimitedError } from '../errors/rate-limited.error';

/**
 * Applies the `@RateLimit(...)` decorator.
 *
 * Registered globally (as an `APP_GUARD` provider inside `RateLimitModule`,
 * so `app.module.ts` only gains an import) and yet inert on almost every
 * route: with no metadata it returns `true` before touching Redis, so an
 * unlimited endpoint pays nothing at all. See the decorator for why "no
 * decorator" means "no limit" here and the reverse in the auth guard.
 *
 * Registered with `useClass` in `AppModule`, not as a provider of
 * `RateLimitModule`, because its dependencies span two modules: the limiter
 * and its config from `RateLimitModule`, and the access-token verifier from
 * `AuthModule` (issue #271). `AppModule` is the one place both are visible,
 * which is also where `AuthenticationGuard` gets `TokenService` from.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
    @Inject(ACCESS_TOKEN_SUBJECT_VERIFIER)
    private readonly verifyAccessTokenSubject: AccessTokenSubjectVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (options === undefined) {
      return true;
    }

    // A global guard also runs for WebSocket and microservice contexts, where
    // `switchToHttp()` yields an object that has no `.ip` and no headers.
    // Socket flooding is a real limit but a different one — per connection,
    // per second, against a live socket
    // (docs/architecture/realtime-architecture.md) — and silently applying an
    // hourly per-IP HTTP budget to it would be wrong in both directions.
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const policy = this.config.policies[options.policy];

    const checks: RateLimitRequest[] = [];

    const identifier = options.identifier?.(request, this.verifyAccessTokenSubject);
    if (identifier !== undefined && identifier !== '') {
      checks.push({
        scope: options.policy,
        dimension: 'identifier',
        subject: identifier,
        limit: policy.perIdentifier,
        windowMs: policy.windowMs,
        backoffCeilingMs: policy.backoffCeilingMs,
      });
    }

    checks.push({
      scope: options.policy,
      dimension: 'ip',
      // Fastify's `request.ip` is the socket peer, because `trustProxy` is
      // NOT enabled on this server. That is the correct setting today and a
      // deliberate one: turning `trustProxy` on without a list of trusted
      // hops makes `X-Forwarded-For` client-controlled, and a client that can
      // choose its own key can give itself a fresh budget on every request —
      // the per-IP limit would still be there, still be tested, and defend
      // nothing. When a reverse proxy lands (EPIC 17), `trustProxy` is
      // configured with that proxy's address at the same time, not before.
      subject: request.ip,
      limit: policy.perIp,
      windowMs: policy.windowMs,
      backoffCeilingMs: policy.backoffCeilingMs,
    });

    // Both dimensions are always evaluated, never short-circuited on the
    // first denial. Short-circuiting would stop counting the IP once a single
    // phone number was limited, which is exactly backwards: an attacker
    // rotating numbers from one host would keep their IP budget frozen at the
    // moment of their first refusal.
    const decisions = await Promise.all(checks.map((check) => this.limiter.consume(check)));
    const denied = worstDenial(decisions);

    if (denied === undefined) {
      return true;
    }

    // A security event (docs/engineering/security.md § Logging). The subject
    // appears ONLY as its keyed digest — never the phone number, never the
    // raw IP — which is enough to correlate repeated abuse from one source
    // across log lines without putting a phone number in a file that more
    // people read than expect to.
    //
    // Correlated on Fastify's own `request.id`, NOT on `request.requestId`:
    // Nest runs guards before interceptors, so `RequestIdInterceptor` has not
    // run yet and `requestId` is still undefined here. Logging it would print
    // the literal string "undefined" on every rate-limit event — a
    // correlation key that correlates nothing.
    this.logger.warn(
      `[req ${request.id}] rate limit exceeded: policy=${options.policy} ` +
        `dimension=${denied.dimension} subject=${denied.subjectDigest} ` +
        `retryAfter=${String(denied.retryAfterSeconds)}s`,
    );

    throw new RateLimitedError(denied.retryAfterSeconds);
  }
}

/**
 * Of the limits that denied, the one the caller must actually wait for.
 *
 * Reporting the shorter wait would have the client retry into a limit that is
 * still closed and be refused again — which, because a refused request is
 * still counted, extends the backoff further. A retry hint that provokes the
 * behaviour it exists to prevent is worse than none.
 */
function worstDenial(decisions: readonly RateLimitDecision[]): RateLimitDecision | undefined {
  let worst: RateLimitDecision | undefined;
  for (const decision of decisions) {
    if (decision.allowed) {
      continue;
    }
    if (worst === undefined || decision.retryAfterSeconds > worst.retryAfterSeconds) {
      worst = decision;
    }
  }
  return worst;
}
