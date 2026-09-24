import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DatabaseModule } from '../../infra/database/database.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { CallSignallingModule } from '../calls/call-signalling.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminActorService } from './admin-actor.service';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminCallsController } from './admin-calls.controller';
import { AdminCallsService } from './admin-calls.service';
import { AdminIdentityController } from './admin-identity.controller';
import { AdminMastersController } from './admin-masters.controller';
import { AdminMastersService } from './admin-masters.service';
import { AdminOrderPhotosController } from './admin-order-photos.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrderPhotosService } from './admin-order-photos.service';
import { AdminOrdersService } from './admin-orders.service';
import { AdminReviewsController } from './admin-reviews.controller';
import { AdminReviewsService } from './admin-reviews.service';
import { AdminSessionService } from './admin-session.service';
import { AdminSetupService } from './admin-setup.service';
import { AdminSignInService } from './admin-sign-in.service';
import { AdminTokenService } from './admin-token.service';
import { createAdminAuthConfig } from './admin.config';
import { AdminRepository } from './admin.repository';
import { ADMIN_CONFIG } from './admin.types';

/**
 * The admin surface, and the authorization layer it runs on.
 *
 * **This layer was ADR-0014's EPIC 2 work, and EPIC 2 shipped without it.**
 * The ADR is explicit that "admin authorization lives in the shared
 * authorization layer and ships with EPIC 2, not EPIC 13", precisely to break
 * the dependency cycle it saw coming: EPIC 3, 5 and 8 each ship admin
 * endpoints, EPIC 13 depends on 5 and 8, so deferring the admin role to 13
 * closes the graph on itself. Issue #39 is where that cycle actually bit, and
 * therefore where the layer is built. Credential issuance stays in EPIC 13, as
 * the same ADR says.
 *
 * `AdminAuthenticationGuard` is **not** registered here. It is a global
 * `APP_GUARD` in `AppModule`, beside the two consumer guards and ahead of
 * them, for two reasons. A controller-scoped guard would protect the
 * controller it is written on and nothing else, so the next admin controller —
 * EPIC 13 will add several — would be protected only if somebody remembered.
 * And the ordering is load-bearing: `AuthenticationGuard` refuses to serve an
 * `/admin` request that has no admin actor on it, which is only a safe check
 * if the admin guard has already had its turn. Both facts are visible in one
 * list in `app.module.ts` rather than split across two modules.
 *
 * `MastersModule` is imported for the two services that own master state, and
 * `AuthModule` for `SessionsService`: suspending a master revokes every
 * session that master holds, and the session model is not this module's to
 * reach into directly. `OrdersModule` arrives with issue #83, for
 * `OrderPhotosService` — `AdminOrderPhotosService` reads a photo through it
 * rather than importing `OrdersModule`'s repository directly
 * (`docs/architecture/backend-architecture.md` § Module rules) — and issue
 * #137 uses it for `OrdersService`, whose `override` is the *same* method the
 * customer and master transitions go through, with the actor entitlement as
 * the only difference. The arrow points one way: `modules/orders` knows
 * nothing about admins beyond the id that goes on a trail row.
 * `CallSignallingModule` arrives with issue #186, for `CallRecordsService`,
 * which reads call records for `GET /admin/calls` the same way it reads a
 * party's own; the arrow again points one way.
 */
@Module({
  imports: [
    DatabaseModule,
    StorageModule,
    AuthModule,
    MastersModule,
    OrdersModule,
    CallSignallingModule,
    // EPIC 11 (#223, #224): recalculation and moderation of reviews.
    ReviewsModule,
  ],
  controllers: [
    AdminAccountsController,
    AdminAuditController,
    AdminAuthController,
    AdminIdentityController,
    AdminMastersController,
    AdminOrderPhotosController,
    AdminOrdersController,
    AdminCallsController,
    AdminReviewsController,
  ],
  providers: [
    {
      provide: ADMIN_CONFIG,
      inject: [APP_CONFIG],
      useFactory: createAdminAuthConfig,
    },
    AdminRepository,
    AdminTokenService,
    AdminActorService,
    AdminSessionService,
    AdminSetupService,
    AdminSignInService,
    AdminAuditService,
    AdminAccountsService,
    AdminMastersService,
    AdminOrderPhotosService,
    AdminOrdersService,
    AdminCallsService,
    AdminReviewsService,
  ],
  exports: [
    AdminRepository,
    AdminSetupService,
    AdminSessionService,
    AdminMastersService,
    AdminTokenService,
    AdminActorService,
  ],
})
export class AdminModule {}
