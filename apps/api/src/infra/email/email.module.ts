import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { EMAIL_SENDER } from './email-sender.types';
import type { EmailSender } from './email-sender.types';
import { StubEmailSender } from './stub-email-sender';

/**
 * Chooses the {@link EmailSender} from validated configuration (ADR-0072).
 *
 * `stub` is the only provider until the owner chooses one, and it refuses to
 * construct under `NODE_ENV=production` — so a deploy fails here, during
 * `NestFactory.create`, naming the variable, rather than booting a service
 * that cannot sign anyone in.
 *
 * No vendor type escapes this folder.
 */
export function createEmailSender(config: AppConfig): EmailSender {
  switch (config.email.provider) {
    case 'stub':
      return new StubEmailSender(config.runtime.nodeEnv);
  }
}

@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: createEmailSender,
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
