import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { describe, expect, it } from 'vitest';

import { ExpoPushSender } from './expo-push-sender';
import type { ExpoPushClient } from './expo-push-sender';
import type { PushEnvelope } from './push-sender.types';

/**
 * The adapter, against a fake client.
 *
 * A fake rather than the real `Expo` pointed at a local server: the SDK's own
 * `EXPO_BASE_URL` override is documented as internal to Expo, and the thing
 * worth pinning here is the **mapping** — which Expo answer becomes which of
 * the four decisions a caller can act on — not that undici can reach a socket.
 */

/**
 * Mirrors the real chunker's limit, verified against `expo-server-sdk@7.2.0`:
 * `Expo.pushNotificationChunkSizeLimit === 100`, and 250 messages chunk as
 * [100, 100, 50].
 */
const CHUNK_LIMIT = 100;

class FakeExpo {
  readonly chunksSent: ExpoPushMessage[][] = [];

  constructor(private readonly ticketFor: (message: ExpoPushMessage) => ExpoPushTicket) {}

  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
    const chunks: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += CHUNK_LIMIT) {
      chunks.push(messages.slice(i, i + CHUNK_LIMIT));
    }
    return chunks;
  }

  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    this.chunksSent.push(messages);
    return Promise.resolve(messages.map((message) => this.ticketFor(message)));
  }
}

function senderWith(ticketFor: (message: ExpoPushMessage) => ExpoPushTicket): {
  sender: ExpoPushSender;
  client: FakeExpo;
} {
  const client = new FakeExpo(ticketFor);
  return {
    sender: new ExpoPushSender(client),
    client,
  };
}

function envelope(token: string): PushEnvelope {
  return {
    pushToken: token,
    title: 'Yaxınlıqda yeni sifariş',
    body: 'Baxmaq üçün toxunun.',
    data: { kind: 'order-offer', orderId: '0199c0de-0000-7000-8000-000000000001' },
  };
}

const ok = (id: string): ExpoPushTicket => ({ status: 'ok', id });
const failed = (error: string): ExpoPushTicket => ({
  status: 'error',
  message: `push failed: ${error}`,
  details: { error: error as never },
});

describe('ExpoPushSender (issue #141)', () => {
  it('sends nothing and answers nothing for an empty batch', async () => {
    const { sender, client } = senderWith(() => ok('unused'));

    expect(await sender.send([])).toEqual([]);
    expect(client.chunksSent).toEqual([]);
  });

  it('turns an accepted ticket into a receipt id the sweep can chase', async () => {
    const { sender } = senderWith((message) => ok(`receipt-for-${String(message.to)}`));

    const outcomes = await sender.send([envelope('ExponentPushToken[aaaa]')]);

    expect(outcomes).toEqual([
      { status: 'accepted', receiptId: 'receipt-for-ExponentPushToken[aaaa]' },
    ]);
  });

  it('splits a batch larger than one request into chunks, and sends every one', async () => {
    const { sender, client } = senderWith((message) => ok(`r-${String(message.to)}`));
    const envelopes = Array.from({ length: 250 }, (_, i) =>
      envelope(`ExponentPushToken[token-${String(i)}]`),
    );

    const outcomes = await sender.send(envelopes);

    expect(client.chunksSent.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    // One outcome per envelope, still in order — the promise the port makes.
    expect(outcomes).toHaveLength(250);
    expect(outcomes[0]).toEqual({ status: 'accepted', receiptId: 'r-ExponentPushToken[token-0]' });
    expect(outcomes[249]).toEqual({
      status: 'accepted',
      receiptId: 'r-ExponentPushToken[token-249]',
    });
  });

  it.each([
    ['DeviceNotRegistered', 'unreachable'],
    ['MessageTooBig', 'rejected'],
    ['DeveloperError', 'rejected'],
    ['InvalidCredentials', 'rejected'],
    ['MessageRateExceeded', 'retryable'],
    ['ProviderError', 'retryable'],
    ['ExpoError', 'retryable'],
  ])('maps the %s ticket to %s', async (code, expected) => {
    const { sender } = senderWith(() => failed(code));

    const [outcome] = await sender.send([envelope('ExponentPushToken[bbbb]')]);

    expect(outcome?.status).toBe(expected);
  });

  it('treats an error code it has never seen as retryable, not as a dead device', async () => {
    const { sender } = senderWith(() => failed('SomethingExpoAddedLastTuesday'));

    const [outcome] = await sender.send([envelope('ExponentPushToken[cccc]')]);

    // Retiring a working device on a word nobody has read is the worse
    // failure: that phone then receives nothing, ever, and nothing says why.
    expect(outcome?.status).toBe('retryable');
  });

  it('keeps one device’s failure from costing the others their delivery', async () => {
    const { sender } = senderWith((message) =>
      String(message.to).includes('dead') ? failed('DeviceNotRegistered') : ok('receipt'),
    );

    const outcomes = await sender.send([
      envelope('ExponentPushToken[live-1]'),
      envelope('ExponentPushToken[dead]'),
      envelope('ExponentPushToken[live-2]'),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'accepted',
      'unreachable',
      'accepted',
    ]);
  });

  it('carries only ids in the payload, never a rendered address or coordinate', async () => {
    const { sender, client } = senderWith(() => ok('receipt'));

    await sender.send([envelope('ExponentPushToken[dddd]')]);

    const sentData = client.chunksSent[0]?.[0]?.data;
    expect(sentData).toEqual({
      kind: 'order-offer',
      orderId: '0199c0de-0000-7000-8000-000000000001',
    });
  });

  it('lets a whole-request failure escape, so the job is retried rather than lost', async () => {
    const client: ExpoPushClient = {
      chunkPushNotifications: (messages: ExpoPushMessage[]) => [messages],
      sendPushNotificationsAsync: () => Promise.reject(new Error('socket hang up')),
    };
    const sender = new ExpoPushSender(client);

    await expect(sender.send([envelope('ExponentPushToken[eeee]')])).rejects.toThrow(
      'socket hang up',
    );
  });
});
