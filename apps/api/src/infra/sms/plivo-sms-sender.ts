import { Logger } from '@nestjs/common';

import { maskPhone } from '../phone/azerbaijani-phone';
import type { OutboundSms, SmsSender } from './sms-sender.types';
import type { SmsFetch } from './sms-http';
import { basicAuth, postToProvider } from './sms-http';

export interface PlivoSettings {
  readonly authId: string;
  readonly authToken: string;
  /** The alphanumeric sender, `TezUsta`. */
  readonly senderId: string;
  readonly timeoutMs: number;
}

/**
 * Plivo's plain SMS API, the primary (ADR-0059). Not Plivo Verify: TezUsta
 * generates, hashes and checks its own codes, and a Verify product would want
 * to own that flow.
 *
 * `POST https://api.plivo.com/v1/Account/{auth_id}/Message/`, Basic auth with
 * the Auth ID and Auth Token, a JSON body of `src`, `dst` (E.164, with the
 * `+`) and `text`; the answer carries `message_uuid`, an array. From Plivo's
 * "Send a message" reference, read 21 October 2026. `fetch` rather than the
 * SDK: one call needs no dependency (CLAUDE.md § 10).
 */
export class PlivoSmsSender implements SmsSender {
  private readonly logger = new Logger(PlivoSmsSender.name);

  constructor(
    private readonly settings: PlivoSettings,
    private readonly fetchImpl: SmsFetch = fetch,
    private readonly baseUrl = 'https://api.plivo.com',
  ) {}

  async send(message: OutboundSms): Promise<void> {
    const answer = await postToProvider(
      'plivo',
      this.fetchImpl,
      `${this.baseUrl}/v1/Account/${encodeURIComponent(this.settings.authId)}/Message/`,
      {
        headers: {
          authorization: basicAuth(this.settings.authId, this.settings.authToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ src: this.settings.senderId, dst: message.to, text: message.body }),
      },
      this.settings.timeoutMs,
    );
    const ids = (answer as { message_uuid?: unknown } | null)?.message_uuid;
    const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : 'unknown';
    // The provider's id, the masked number and nothing else (ADR-0008).
    this.logger.log(`sms queued: provider=plivo id=${id} to=${maskPhone(message.to)}`);
  }
}
