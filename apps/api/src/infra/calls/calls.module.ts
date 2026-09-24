import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { CALL_MEDIA_PROVIDER } from './call-media.types';
import type { CallMediaProvider } from './call-media.types';
import { LiveKitCallMediaProvider } from './livekit-call-media.provider';
import { StubCallMediaProvider } from './stub-call-media.provider';

/**
 * Chooses the {@link CallMediaProvider} implementation from validated
 * configuration — `PushModule`'s shape, for `PushModule`'s reason: the real
 * provider is decided (ADR-0034), so both implementations ship.
 *
 * `AppConfig['calls']` is a union discriminated on `provider`, which is what
 * makes the `switch` exhaustive and hands the `livekit` branch its URL, key
 * and secret already proven present — `env.schema.ts` refused the boot
 * otherwise, with every missing name listed. There is nothing left for this
 * factory to check, and so nothing here that could fail late.
 */
export function createCallMediaProvider(config: AppConfig): CallMediaProvider {
  const calls = config.calls;
  switch (calls.provider) {
    case 'livekit':
      return new LiveKitCallMediaProvider({
        ...calls.livekit,
        joinTokenTtlSeconds: calls.joinTokenTtlSeconds,
      });
    case 'stub':
      // Refuses to construct under NODE_ENV=production, so a deploy that
      // forgot to configure calls fails during `NestFactory.create` with a
      // message naming the variable, rather than on the first accepted call.
      return new StubCallMediaProvider(config.runtime.nodeEnv, calls.joinTokenTtlSeconds);
  }
}

/**
 * Registered in `AppModule` ahead of its first consumer (#185), so the choice
 * above runs at every boot from this release on: a production deploy learns
 * that `CALLS_PROVIDER` is unset now, while nothing depends on calls, rather
 * than on the release where it would take the feature down with it.
 */
@Module({
  providers: [
    {
      provide: CALL_MEDIA_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createCallMediaProvider,
    },
  ],
  exports: [CALL_MEDIA_PROVIDER],
})
export class CallsModule {}
