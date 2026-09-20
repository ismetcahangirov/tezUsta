import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { RequestIdHook } from './common/request-context/request-id.hook';
import { ConfigModule } from './infra/config/config.module';
import { DatabaseModule } from './infra/database/database.module';
import { QueueModule } from './infra/queue/queue.module';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { RateLimitModule } from './infra/rate-limit/rate-limit.module';
import { RedisModule } from './infra/redis/redis.module';
import { AddressesModule } from './modules/addresses/addresses.module';
import { AdminAuthenticationGuard } from './modules/admin/admin-authentication.guard';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthenticationGuard } from './modules/auth/authentication.guard';
import { OtpModule } from './modules/auth/otp.module';
import { RolesGuard } from './modules/auth/roles.guard';
import { CustomersModule } from './modules/customers/customers.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { GeocodingModule } from './modules/geocoding/geocoding.module';
import { HealthModule } from './modules/health/health.module';
import { MastersModule } from './modules/masters/masters.module';
import { MasterOffersModule } from './modules/masters/offers/master-offers.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ServicesModule } from './modules/services/services.module';
import { UsersModule } from './modules/users/users.module';

/**
 * The globals are registered HERE, as module providers, rather than
 * through `app.useGlobal*()` in `main.ts`.
 *
 * `main.ts` is not imported by anything, so a global registered there exists
 * only in the shipped binary: a test that builds its own app via
 * `Test.createTestingModule({ imports: [AppModule] })` would not get it.
 * Deleting the `useGlobalFilters` line would then leave every test green while
 * the running service started returning driver text and stack traces to
 * clients — the exact guarantee `all-exceptions.filter.ts` exists to provide,
 * asserted against an app that only existed inside the test file.
 *
 * Registering them as providers makes the wiring part of `AppModule`, so the
 * integration tests exercise the real thing.
 *
 * That reasoning is sharpest for the two `APP_GUARD` entries, and they are why
 * this list must not move: they are what makes the API **secure by default**
 * (issue #27). A route that carries no decorator is protected because these
 * lines exist, so a `main.ts`-only registration would mean every test in the
 * repository exercised an application in which nothing was protected at all.
 *
 * **Order within `providers` is behaviour, not formatting.** Nest runs global
 * guards in registration order, and all three are listed here for that reason
 * rather than each module registering its own:
 *
 * 1. `RateLimitGuard` — first, so a request is COUNTED before it can be
 *    rejected. When this one lived in `RateLimitModule` and the others here,
 *    authentication ran first, and an unauthenticated flood against a
 *    protected rate-limited route was answered 401 without ever reaching the
 *    counter — free hammering with a junk token, against the very limit meant
 *    to stop it. `auth.rate-limit.e2e.test.ts` now asserts this order.
 * 2. `AuthenticationGuard` — resolves the actor from the database.
 * 3. `RolesGuard` — reads the actor the previous guard attached, so swapping
 *    those two would make every `@Roles(...)` route reject its own users.
 *
 * `RequestIdHook` is listed first for readability only. It is not part of the
 * guard chain at all: it fills Fastify's `onRequest` hook slot, which runs
 * before routing and therefore before every guard, every interceptor, and the
 * two handlers — 404 and adapter-layer error — that build no interceptor chain
 * at all (issue #47). It is a provider here for the same reason as the rest of
 * this list: a hook installed from `main.ts` would exist in no test.
 */
@Module({
  imports: [
    ConfigModule,
    HealthModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    QueueModule,
    UsersModule,
    AuthModule,
    OtpModule,
    ServicesModule,
    CustomersModule,
    AddressesModule,
    MastersModule,
    OrdersModule,
    // After `OrdersModule`, which it imports. The master's offer surface is a
    // leaf over masters + orders + addresses (issue #101).
    MasterOffersModule,
    DispatchModule,
    AdminModule,
    GeocodingModule,
  ],
  providers: [
    RequestIdHook,
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    // Ahead of AuthenticationGuard, and the order matters. The consumer guard
    // refuses to serve any request under `/admin` that has not already had an
    // admin actor resolved onto it, which turns "somebody forgot to register
    // the admin guard" from an unauthenticated admin surface into a 401 on
    // every admin route. That check is only sound if this has already run.
    { provide: APP_GUARD, useClass: AdminAuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
