import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { CDN_PURGER } from './cdn-purger.types';
import type { CdnPurger } from './cdn-purger.types';
import { CloudflareCdnPurger } from './cloudflare-cdn-purger';
import { StubCdnPurger } from './stub-cdn-purger';

/**
 * Chooses the {@link CdnPurger} from validated configuration, as
 * `CallsModule` chooses its provider.
 *
 * `AppConfig['cdn']` is a union discriminated on `purgeProvider`, so the
 * `cloudflare` branch receives its zone and token already proven present —
 * `env.schema.ts` refused the boot otherwise.
 */
export function createCdnPurger(config: AppConfig): CdnPurger {
  const cdn = config.cdn;
  switch (cdn.purgeProvider) {
    case 'cloudflare':
      return new CloudflareCdnPurger(cdn.cloudflare);
    case 'stub':
      // Refuses to construct under NODE_ENV=production.
      return new StubCdnPurger(config.runtime.nodeEnv);
  }
}

/**
 * Registered in `AppModule` ahead of its first consumer (the deletion sweeps,
 * #311), for `CallsModule`'s reason: a production deploy learns that
 * `CDN_PURGE_PROVIDER` is unset now, rather than on the release where the
 * first deleted photo would stay public.
 */
@Module({
  providers: [
    {
      provide: CDN_PURGER,
      inject: [APP_CONFIG],
      useFactory: createCdnPurger,
    },
  ],
  exports: [CDN_PURGER],
})
export class CdnModule {}
