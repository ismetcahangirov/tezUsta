import { Module } from '@nestjs/common';

import { GeocodingInfraModule } from '../../infra/geo/geocoding.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { OtpModule } from '../auth/otp.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { MaintenanceService } from './maintenance.service';

/**
 * Where the retention sweeps live (#57, #69, #92, #128, #276).
 *
 * It owns no table and exports nothing. It imports the modules whose data it
 * retires and asks each of them for the repository that owns the statement —
 * the deletes are written where the table's other queries are, so a schema
 * change lands next to every query that depends on it rather than in a module
 * nobody would think to look at.
 *
 * The direction is the one that matters: this module depends on `AuthModule`,
 * `OtpModule`, `AdminModule`, `OrdersModule` and the geocoding infrastructure,
 * and none of them knows it exists. Retention is a policy applied to a table,
 * not a feature of it, so nothing about the sign-in path, the admin sign-in
 * path, or the photo-upload path changes when the policy does.
 *
 * `AdminModule` is imported for `AdminRepository` alone (#276) — the sweep
 * needs none of its controllers or admin-facing services, only the repository
 * that already owns `admin_sessions`/`admin_refresh_tokens`. `AdminModule`
 * already exports it for its own admin-facing services, so this is the same
 * shape as reaching into `AuthModule` for `SessionsRepository`.
 */
@Module({
  imports: [
    QueueModule,
    AuthModule,
    OtpModule,
    AdminModule,
    OrdersModule,
    MastersModule,
    GeocodingInfraModule,
    StorageModule,
  ],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
