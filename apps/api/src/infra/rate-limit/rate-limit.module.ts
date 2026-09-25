import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { RedisModule } from '../redis/redis.module';
import { createRateLimitConfig } from './rate-limit.config';
import { RATE_LIMIT_CONFIG } from './rate-limit.tokens';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Redis-backed rate limiting for the authentication surface (issue #28).
 *
 * Lives under `infra/` rather than in `modules/auth/` because it is a
 * mechanism, not an auth policy: order creation, review submission and
 * location ingest all need the same counter
 * (`docs/engineering/security.md` § Rate limiting and abuse), and none of
 * them should have to import the auth module to get it. `AuthModule` does not
 * import this one either — the coupling runs through the `@RateLimit`
 * decorator on a controller, which is metadata, not a dependency.
 *
 * `RateLimitGuard` is deliberately NOT registered as `APP_GUARD` here,
 * even though a module carrying its own cross-cutting wiring is the pattern
 * everywhere else in this codebase (`readiness-check.registry.ts` makes that
 * argument, and it is a good one).
 *
 * The reason is that **guard order is a security property here, and splitting
 * the registrations across modules makes it implicit.** Nest runs global
 * guards in the order their providers are built, and when this module
 * registered its own, the authentication guard from `AppModule` ran FIRST — so
 * an unauthenticated request to a protected, rate-limited route was rejected
 * with a 401 before it was ever counted. An attacker hammering such an
 * endpoint with a junk token would have paid nothing, and the limit that
 * exists to bound exactly that traffic would never have fired. That was not
 * reasoned about; it was found by a test that asserted the order
 * (`auth.rate-limit.e2e.test.ts`, "the rate-limit guard runs before the
 * authentication guard").
 *
 * All three global guards are therefore listed together in `AppModule`, where
 * the order is visible on three adjacent lines instead of being an emergent
 * property of module import order.
 *
 * `RateLimitGuard` is not a provider of this module at all: `AppModule` builds
 * it with `useClass`, from this module's exports (the limiter and its config)
 * and `AuthModule`'s access-token verifier (issue #271). Declaring it here as
 * well would need the verifier inside this module — an `infra/` → `modules/`
 * import — and would build a second instance nothing calls.
 *
 * The {@link RATE_LIMIT_CONFIG} factory is where this module refuses to start
 * without `RATE_LIMIT_KEY_SECRET`, mirroring `AuthModule`'s treatment of the
 * JWT secrets and for the reason `app-config.types.ts` states: the module
 * that first needs an optional value is the one responsible for failing its
 * own startup when it is missing.
 */
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: RATE_LIMIT_CONFIG,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRateLimitConfig(config),
    },
    RateLimiterService,
  ],
  // Exported so the OTP module (issue #29) can inject the attempt counter
  // directly — the cap on code guesses is not a route-level limit and has no
  // decorator — and so `AppModule` can build `RateLimitGuard` from them.
  exports: [RateLimiterService, RATE_LIMIT_CONFIG],
})
export class RateLimitModule {}
