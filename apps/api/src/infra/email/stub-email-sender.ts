import { Logger } from '@nestjs/common';

import { maskEmail } from './email-address';
import type { EmailSender, OutboundEmail } from './email-sender.types';

/**
 * Thrown when the stub sender is constructed in production.
 *
 * This is what makes the development stub impossible to enable in production.
 * A runtime `if (nodeEnv !== 'production')` around the log line would not do
 * it: the service would still boot, still accept OTP requests, still tell
 * users a code had been sent, and send nothing — a silent, total sign-in
 * outage that every health check reports as green. Refusing to construct
 * turns that into a deployment that fails immediately and says why.
 */
export class StubEmailSenderInProductionError extends Error {
  constructor() {
    super(
      'EMAIL_PROVIDER=stub cannot be used in production: it sends no message, so nobody ' +
        'could sign in, and it prints the OTP code to the log. Configure a real provider ' +
        '(ADR-0072 — the provider decision is still open and blocks launch).',
    );
    this.name = 'StubEmailSenderInProductionError';
    Object.setPrototypeOf(this, StubEmailSenderInProductionError.prototype);
  }
}

/**
 * The development sender: prints the message instead of sending it, so the
 * whole OTP flow is exercisable before a provider is chosen.
 *
 * This is the **only** place in the codebase permitted to put an OTP code
 * anywhere near a log, and it is permitted because it cannot exist outside
 * development — see {@link StubEmailSenderInProductionError}.
 */
export class StubEmailSender implements EmailSender {
  private readonly logger = new Logger(StubEmailSender.name);

  constructor(private readonly nodeEnv: 'development' | 'test' | 'production') {
    if (nodeEnv === 'production') {
      throw new StubEmailSenderInProductionError();
    }
  }

  send(message: OutboundEmail): Promise<void> {
    if (this.nodeEnv === 'development') {
      // The recipient is masked even here. The body is not — printing the code
      // is the entire point of this class in local development, where there is
      // no inbox to receive it. Under `test` neither is printed: a test suite
      // that scrolls OTP codes past a developer trains everyone to expect
      // codes in logs, and `auth.token-logging.test.ts` asserts against it.
      this.logger.warn(`[STUB EMAIL → ${maskEmail(message.to)}] ${message.text}`);
    }
    return Promise.resolve();
  }
}
