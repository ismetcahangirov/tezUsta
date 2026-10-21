import { describe, expect, it } from 'vitest';

import { parseEnv } from '../config/parse-env';
import { AzerbaijanOnlySmsSender } from './azerbaijan-only-sms-sender';
import { createSmsSender, MissingSmsSettingsError } from './sms.module';
import { StubSmsSender, StubSmsSenderInProductionError } from './stub-sms-sender';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const PLIVO = {
  SMS_PROVIDER: 'plivo',
  SMS_SENDER_ID: 'TezUsta',
  PLIVO_AUTH_ID: 'MAXXXX',
  PLIVO_AUTH_TOKEN: 'plivo-token',
};

describe('createSmsSender (#390, ADR-0059)', () => {
  it('builds the stub by default, and the stub refuses production', () => {
    expect(createSmsSender(parseEnv(BASE_ENV))).toBeInstanceOf(StubSmsSender);
    expect(() => createSmsSender(parseEnv({ ...BASE_ENV, NODE_ENV: 'production' }))).toThrow(
      StubSmsSenderInProductionError,
    );
  });

  it('builds a real provider behind the +994-only guard', () => {
    expect(createSmsSender(parseEnv({ ...BASE_ENV, ...PLIVO }))).toBeInstanceOf(
      AzerbaijanOnlySmsSender,
    );
  });

  it('builds Plivo with Twilio behind it', () => {
    const sender = createSmsSender(
      parseEnv({
        ...BASE_ENV,
        ...PLIVO,
        SMS_FALLBACK_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'ACXXXX',
        TWILIO_AUTH_TOKEN: 'twilio-token',
      }),
    );
    expect(sender).toBeInstanceOf(AzerbaijanOnlySmsSender);
  });

  it('fails at boot naming every missing setting of a chosen provider', () => {
    expect(() =>
      createSmsSender(parseEnv({ ...BASE_ENV, SMS_PROVIDER: 'plivo', SMS_SENDER_ID: 'TezUsta' })),
    ).toThrow(/PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN are not set/);
    expect(() =>
      createSmsSender(parseEnv({ ...BASE_ENV, ...PLIVO, SMS_FALLBACK_PROVIDER: 'twilio' })),
    ).toThrow(MissingSmsSettingsError);
  });

  it('refuses a fallback that is the primary, and a sender that is not alphanumeric', () => {
    expect(() => parseEnv({ ...BASE_ENV, ...PLIVO, SMS_FALLBACK_PROVIDER: 'plivo' })).toThrow(
      /SMS_FALLBACK_PROVIDER/,
    );
    expect(() => parseEnv({ ...BASE_ENV, ...PLIVO, SMS_SENDER_ID: '+994501234567' })).toThrow(
      /SMS_SENDER_ID/,
    );
  });
});
