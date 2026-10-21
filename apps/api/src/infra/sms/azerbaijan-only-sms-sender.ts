import { isAzerbaijaniMobile } from '../phone/azerbaijani-phone';
import type { OutboundSms, SmsSender } from './sms-sender.types';

/** The number is not a +994 mobile, so no message was sent and nothing was paid for. */
export class SmsRecipientRefusedError extends Error {
  constructor() {
    super('Refused to send an SMS to a number that is not an Azerbaijani mobile.');
    this.name = 'SmsRecipientRefusedError';
    Object.setPrototypeOf(this, SmsRecipientRefusedError.prototype);
  }
}

/**
 * Sends only to +994 mobile numbers, **before** any provider is called
 * (#390, ADR-0059).
 *
 * The cheapest fraud control there is: SMS pumping lives on number ranges
 * that pay their operator per message, and every one of them is outside the
 * market TezUsta serves. A landline cannot receive the code anyway. The
 * provider consoles are locked to Azerbaijan as well; this is the same rule
 * enforced where TezUsta can test it.
 */
export class AzerbaijanOnlySmsSender implements SmsSender {
  constructor(private readonly inner: SmsSender) {}

  async send(message: OutboundSms): Promise<void> {
    if (!message.to.startsWith('+994') || !isAzerbaijaniMobile(message.to)) {
      throw new SmsRecipientRefusedError();
    }
    await this.inner.send(message);
  }
}
