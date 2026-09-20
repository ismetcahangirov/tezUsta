import { Module } from '@nestjs/common';

import { GeocodingInfraModule } from '../../infra/geo/geocoding.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { MaintenanceService } from './maintenance.service';

/**
 * Where the retention sweeps live (#57, #69, #92).
 *
 * It owns no table and exports nothing. It imports the modules whose data it
 * retires and asks each of them for the repository that owns the statement —
 * the deletes are written where the table's other queries are, so a schema
 * change lands next to every query that depends on it rather than in a module
 * nobody would think to look at.
 *
 * The direction is the one that matters: this module depends on `AuthModule`,
 * `OrdersModule` and the geocoding infrastructure, and none of them knows it
 * exists. Retention is a policy applied to a table, not a feature of it, so
 * nothing about the sign-in path or the photo-upload path changes when the
 * policy does.
 */
@Module({
  imports: [QueueModule, AuthModule, OrdersModule, GeocodingInfraModule, StorageModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
