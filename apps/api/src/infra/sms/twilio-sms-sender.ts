import { Logger } from '@nestjs/common';

import { maskPhone } from '../phone/azerbaijani-phone';
import type { OutboundSms, SmsSender } from './sms-sender.types';
import type { SmsFetch } from './sms-http';
import { basicAuth, postToProvider } from './sms-http';

export interface TwilioSettings {
  readonly accountSid: string;
  readonly authToken: string;
  /** The alphanumeric sender, `TezUsta`. */
  readonly senderId: string;
  readonly timeoutMs: number;
}

/**
 * Twilio Programmable Messaging, the fallback (ADR-0059). Not Twilio Verify,
 * for the reason Plivo's adapter gives.
 *
 * `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`,
 * Basic auth with the Account SID and Auth Token, a form-encoded body of
 * `To`, `From` and `Body`; the answer carries the message's `sid`. From
 * Twilio's Message resource reference, read 21 October 2026.
 */
export class TwilioSmsSender implements SmsSender {
  private readonly logger = new Logger(TwilioSmsSender.name);

  constructor(
    private readonly settings: TwilioSettings,
    private readonly fetchImpl: SmsFetch = fetch,
    private readonly baseUrl = 'https://api.twilio.com',
  ) {}

  async send(message: OutboundSms): Promise<void> {
    const answer = await postToProvider(
      'twilio',
      this.fetchImpl,
      `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}/Messages.json`,
      {
        headers: {
          authorization: basicAuth(this.settings.accountSid, this.settings.authToken),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: message.to,
          From: this.settings.senderId,
          Body: message.body,
        }).toString(),
      },
      this.settings.timeoutMs,
    );
    const sid = (answer as { sid?: unknown } | null)?.sid;
    this.logger.log(
      `sms queued: provider=twilio id=${typeof sid === 'string' ? sid : 'unknown'} to=${maskPhone(message.to)}`,
    );
  }
}
