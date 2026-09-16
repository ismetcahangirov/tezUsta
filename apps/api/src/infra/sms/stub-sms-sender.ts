import { Logger } from '@nestjs/common';

import { maskPhone } from '../phone/azerbaijani-phone';
import type { OutboundSms, SmsSender } from './sms-sender.types';

/**
 * Thrown when the stub sender is constructed in production.
 *
 * This is the mechanism behind ADR-0008's requirement that the development
 * stub "must be impossible to enable in production". A runtime `if
 * (nodeEnv !== 'production')` around the log line would not satisfy it: the
 * service would still boot, still accept OTP requests, still tell users a code
 * had been sent, and send nothing — a silent, total sign-in outage that every
 * health check reports as green. Refusing to construct turns that into a
 * deployment that fails immediately and says why.
 */
export class StubSmsSenderInProductionError extends Error {
  constructor() {
    super(
      'SMS_PROVIDER=stub cannot be used in production: it sends no message, so nobody could ' +
        'sign in, and it prints the OTP code to the log. Configure a real provider ' +
        '(ADR-0008 — the provider decision is still open and blocks launch).',
    );
    this.name = 'StubSmsSenderInProductionError';
    Object.setPrototypeOf(this, StubSmsSenderInProductionError.prototype);
  }
}

/**
 * The development sender: prints the message instead of sending it, so the
 * whole OTP flow is exercisable before a provider is chosen.
 *
 * This is the **only** place in the codebase permitted to put an OTP code
 * anywhere near a log, and it is permitted because it cannot exist outside
 * development — see {@link StubSmsSenderInProductionError}.
 */
export class StubSmsSender implements SmsSender {
  private readonly logger = new Logger(StubSmsSender.name);

  constructor(private readonly nodeEnv: 'development' | 'test' | 'production') {
    if (nodeEnv === 'production') {
      throw new StubSmsSenderInProductionError();
    }
  }

  send(message: OutboundSms): Promise<void> {
    if (this.nodeEnv === 'development') {
      // The recipient is masked even here. The body is not — printing the code
      // is the entire point of this class in local development, where there is
      // no handset to receive it. Under `test` neither is printed: a test suite
      // that scrolls OTP codes past a developer trains everyone to expect
      // codes in logs, which is exactly the habit ADR-0008 is guarding
      // against, and `auth.token-logging.test.ts` asserts against it.
      this.logger.warn(`[STUB SMS → ${maskPhone(message.to)}] ${message.body}`);
    }
    return Promise.resolve();
  }
}
