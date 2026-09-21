import { Module } from '@nestjs/common';
import { Expo } from 'expo-server-sdk';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { ExpoPushSender } from './expo-push-sender';
import { PUSH_RECEIPT_SOURCE, PUSH_SENDER } from './push-sender.types';
import type { PushSender } from './push-sender.types';
import { StubPushSender } from './stub-push-sender';

/**
 * Chooses the {@link PushSender} implementation from validated configuration.
 *
 * The shape is `SmsModule`'s, with one difference that matters: ADR-0008's SMS
 * provider is **undecided**, so that module has only a stub, while push has a
 * decided provider (`technology-stack.md` — Expo's push service) and ships the
 * real sender here. `PUSH_PROVIDER` is an enum in `env.schema.ts`, which is
 * what makes the `switch` exhaustive and a `default` branch unnecessary rather
 * than omitted.
 */
function createPushSender(config: AppConfig): PushSender {
  switch (config.notifications.provider) {
    case 'expo':
      return new ExpoPushSender(
        // `accessToken` is Expo's optional push-security credential. Omitted
        // when unset rather than passed as `undefined`, because the SDK reads
        // the property's presence.
        new Expo(
          config.notifications.expoAccessToken === undefined
            ? {}
            : { accessToken: config.notifications.expoAccessToken },
        ),
      );
    case 'stub':
      // Refuses to construct under NODE_ENV=production, so a deploy that
      // forgot to configure the provider fails during `NestFactory.create`
      // with a message naming the variable — rather than silently delivering
      // nothing while every health check stays green.
      return new StubPushSender(config.runtime.nodeEnv);
  }
}

@Module({
  providers: [
    {
      provide: PUSH_SENDER,
      inject: [APP_CONFIG],
      useFactory: createPushSender,
    },
    {
      /**
       * The **same object** under a second token, not a second instance
       * (#142). Both halves of Expo's two-phase API are one client with one
       * access token and one concurrency limiter, and the stub's recorded
       * sends have to be the ones its receipts answer about — two instances
       * would answer about nothing.
       *
       * Two tokens rather than one because the sweep must be able to read
       * outcomes and must not be able to send: a port it cannot call is a
       * stronger guarantee than a convention that it does not.
       */
      provide: PUSH_RECEIPT_SOURCE,
      useExisting: PUSH_SENDER,
    },
  ],
  exports: [PUSH_SENDER, PUSH_RECEIPT_SOURCE],
})
export class PushModule {}
