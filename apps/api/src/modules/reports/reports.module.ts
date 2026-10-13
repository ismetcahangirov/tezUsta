import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/**
 * Reports about a party (#330, ADR-0053). The repository is exported for the
 * admin module, which owns the queue and writes its audit rows; the arrow
 * points from admin to here and never back.
 */
@Module({
  imports: [DatabaseModule, CustomersModule, MastersModule],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService],
  exports: [ReportsRepository],
})
export class ReportsModule {}
