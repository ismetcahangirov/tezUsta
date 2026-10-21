import { Logger } from '@nestjs/common';

import { maskPhone } from '../phone/azerbaijani-phone';
import type { OutboundSms, SmsSender } from './sms-sender.types';
import { SmsProviderError } from './sms-http';

/**
 * The primary, and the fallback when the primary throws (#390, ADR-0059).
 *
 * **Only on an error or a timeout**, never on a missing delivery receipt: the
 * providers document no receipts for Azerbaijan, so "not delivered yet" is not
 * a signal, and a second send on it would hand the customer two codes and
 * the bill twice. Success is the customer entering the code.
 *
 * It is one `send` to the caller, so the attempt is counted once against the
 * per-phone and per-IP limits and the daily cap, whichever provider carried
 * it. If both fail, the fallback's error is what the caller sees.
 */
export class FailoverSmsSender implements SmsSender {
  private readonly logger = new Logger(FailoverSmsSender.name);

  constructor(
    private readonly primary: SmsSender,
    private readonly fallback: SmsSender,
  ) {}

  async send(message: OutboundSms): Promise<void> {
    try {
      await this.primary.send(message);
      return;
    } catch (error) {
      this.logger.warn(
        // Only our own error's words: any other one could carry what the
        // request did, and the request carries the code (ADR-0008).
        `primary sms provider failed (${
          error instanceof SmsProviderError
            ? error.message
            : error instanceof Error
              ? error.name
              : 'unknown'
        }); ` + `trying the fallback for ${maskPhone(message.to)}`,
      );
    }
    await this.fallback.send(message);
  }
}
