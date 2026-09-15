import { Module } from '@nestjs/common';

import { ConfigModule } from './infra/config/config.module';
import { DatabaseModule } from './infra/database/database.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [ConfigModule, HealthModule, DatabaseModule, RedisModule],
})
export class AppModule {}
