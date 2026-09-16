import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { SMS_SENDER } from './sms-sender.types';
import type { SmsSender } from './sms-sender.types';
import { StubSmsSender } from './stub-sms-sender';

/**
 * Chooses the {@link SmsSender} implementation from validated configuration.
 *
 * `SMS_PROVIDER` is an enum in `env.schema.ts` with exactly one member today
 * (`'stub'`), which is what makes the `switch` below exhaustive and the
 * `default` branch unreachable rather than defensive. Adding a real provider
 * is: one new file implementing the interface, one enum member, one `case`.
 * Nothing above this module changes, and no vendor type escapes this folder
 * (ADR-0008 § Do not).
 */
function createSmsSender(config: AppConfig): SmsSender {
  switch (config.sms.provider) {
    case 'stub':
      // The stub refuses to construct under NODE_ENV=production, so this
      // factory is also where a production deploy that forgot to configure a
      // provider fails — during `NestFactory.create`, with a message naming
      // the variable, rather than on the first sign-in attempt.
      return new StubSmsSender(config.runtime.nodeEnv);
  }
}

@Module({
  providers: [
    {
      provide: SMS_SENDER,
      inject: [APP_CONFIG],
      useFactory: createSmsSender,
    },
  ],
  exports: [SMS_SENDER],
})
export class SmsModule {}
