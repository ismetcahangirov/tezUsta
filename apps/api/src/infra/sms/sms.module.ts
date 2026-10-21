import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { AzerbaijanOnlySmsSender } from './azerbaijan-only-sms-sender';
import { FailoverSmsSender } from './failover-sms-sender';
import { PlivoSmsSender } from './plivo-sms-sender';
import { SMS_SENDER } from './sms-sender.types';
import type { SmsSender } from './sms-sender.types';
import { StubSmsSender } from './stub-sms-sender';
import { TwilioSmsSender } from './twilio-sms-sender';

/**
 * A real provider was chosen but one of its settings is missing. Thrown at
 * boot, naming every missing variable, rather than on the first sign-in.
 */
export class MissingSmsSettingsError extends Error {
  constructor(provider: string, missing: readonly string[]) {
    super(
      `SMS_PROVIDER or SMS_FALLBACK_PROVIDER names "${provider}", but ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set (see .env.example, ADR-0059).`,
    );
    this.name = 'MissingSmsSettingsError';
    Object.setPrototypeOf(this, MissingSmsSettingsError.prototype);
  }
}

function requireSettings(
  provider: string,
  settings: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const missing = Object.entries(settings)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new MissingSmsSettingsError(provider, missing);
  }
  return settings as Record<string, string>;
}

/** One real provider's sender, from its own settings. */
function createProvider(name: 'plivo' | 'twilio', config: AppConfig): SmsSender {
  const { sms } = config;
  switch (name) {
    case 'plivo': {
      const set = requireSettings('plivo', {
        PLIVO_AUTH_ID: sms.plivo.authId,
        PLIVO_AUTH_TOKEN: sms.plivo.authToken,
        SMS_SENDER_ID: sms.senderId,
      });
      return new PlivoSmsSender({
        authId: set.PLIVO_AUTH_ID ?? '',
        authToken: set.PLIVO_AUTH_TOKEN ?? '',
        senderId: set.SMS_SENDER_ID ?? '',
        timeoutMs: sms.timeoutMs,
      });
    }
    case 'twilio': {
      const set = requireSettings('twilio', {
        TWILIO_ACCOUNT_SID: sms.twilio.accountSid,
        TWILIO_AUTH_TOKEN: sms.twilio.authToken,
        SMS_SENDER_ID: sms.senderId,
      });
      return new TwilioSmsSender({
        accountSid: set.TWILIO_ACCOUNT_SID ?? '',
        authToken: set.TWILIO_AUTH_TOKEN ?? '',
        senderId: set.SMS_SENDER_ID ?? '',
        timeoutMs: sms.timeoutMs,
      });
    }
  }
}

/**
 * Chooses the {@link SmsSender} from validated configuration (ADR-0008,
 * ADR-0059).
 *
 * - `stub` — development and tests. It refuses to construct under
 *   `NODE_ENV=production`, so a deploy that forgot to configure a provider
 *   fails here, during `NestFactory.create`, naming the variable.
 * - `plivo` or `twilio` — that provider, and `SMS_FALLBACK_PROVIDER`'s behind
 *   it when one is set. Every real sender is wrapped so that nothing but a
 *   +994 mobile is ever sent to (`AzerbaijanOnlySmsSender`).
 *
 * No vendor type escapes this folder (ADR-0008 § Do not).
 */
export function createSmsSender(config: AppConfig): SmsSender {
  const { provider, fallbackProvider } = config.sms;
  if (provider === 'stub') {
    return new StubSmsSender(config.runtime.nodeEnv);
  }
  const primary = createProvider(provider, config);
  const sender =
    fallbackProvider === undefined
      ? primary
      : new FailoverSmsSender(primary, createProvider(fallbackProvider, config));
  return new AzerbaijanOnlySmsSender(sender);
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
