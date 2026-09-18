import { Module } from '@nestjs/common';

import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DatabaseModule } from '../../infra/database/database.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { AdminActorService } from './admin-actor.service';
import { AdminMastersController } from './admin-masters.controller';
import { AdminMastersService } from './admin-masters.service';
import { AdminOrderPhotosController } from './admin-order-photos.controller';
import { AdminOrderPhotosService } from './admin-order-photos.service';
import { AdminSessionService } from './admin-session.service';
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
 * (`docs/architecture/backend-architecture.md` § Module rules).
 */
@Module({
  imports: [DatabaseModule, StorageModule, AuthModule, MastersModule, OrdersModule],
  controllers: [AdminMastersController, AdminOrderPhotosController],
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
    AdminMastersService,
    AdminOrderPhotosService,
  ],
  exports: [
    AdminRepository,
    AdminSessionService,
    AdminMastersService,
    AdminTokenService,
    AdminActorService,
  ],
})
export class AdminModule {}
