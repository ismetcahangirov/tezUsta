import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
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

/**
 * The receipt chunker's own, separate limit — also verified against
 * `expo-server-sdk@7.2.0`: `Expo.pushNotificationReceiptChunkSizeLimit === 300`.
 * The two numbers differ, which is the reason the adapter uses the vendor's
 * two chunkers rather than one constant of its own.
 */
const RECEIPT_CHUNK_LIMIT = 300;

class FakeExpo {
  readonly chunksSent: ExpoPushMessage[][] = [];
  readonly receiptChunksAsked: string[][] = [];

  /** What this fake answers for a receipt id. Absent means "not ready yet". */
  readonly receipts = new Map<string, ExpoPushReceipt>();

  constructor(private readonly ticketFor: (message: ExpoPushMessage) => ExpoPushTicket) {}

  chunkPushNotificationReceiptIds(receiptIds: string[]): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < receiptIds.length; i += RECEIPT_CHUNK_LIMIT) {
      chunks.push(receiptIds.slice(i, i + RECEIPT_CHUNK_LIMIT));
    }
    return chunks;
  }

  getPushNotificationReceiptsAsync(
    receiptIds: string[],
  ): Promise<{ [id: string]: ExpoPushReceipt }> {
    this.receiptChunksAsked.push(receiptIds);
    const answer: { [id: string]: ExpoPushReceipt } = {};
    for (const receiptId of receiptIds) {
      const receipt = this.receipts.get(receiptId);
      if (receipt !== undefined) {
        answer[receiptId] = receipt;
      }
    }
    return Promise.resolve(answer);
  }

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
    channelId: 'order-offers',
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

  it("addresses the envelope's Android channel, so the phone can silence one category (#157)", async () => {
    const { sender, client } = senderWith(() => ok('receipt'));

    await sender.send([envelope('ExponentPushToken[eeee]')]);

    // Expo forwards this as FCM v1's `android.notification.channel_id`. A
    // message without it is delivered into the manifest's default channel, so
    // the whole point of creating five channels in the app is lost here if the
    // field is dropped — and nothing would report that it had been.
    expect(client.chunksSent[0]?.[0]?.channelId).toBe('order-offers');
  });

  /**
   * #189. Every push this product sends already goes at high priority; what
   * the ring adds is an expiry and an iOS sound — and only the ring. A `ttl`
   * leaking onto an order update would drop it for a phone that was off for a
   * minute, so absence is asserted as carefully as presence.
   */
  it('sends an envelope with no ttl or sound exactly as before: high priority, no expiry, no sound', async () => {
    const { sender, client } = senderWith(() => ok('receipt'));

    await sender.send([envelope('ExponentPushToken[ffff]')]);

    const message = client.chunksSent[0]?.[0];
    expect(message?.priority).toBe('high');
    expect(message).not.toHaveProperty('ttl');
    expect(message).not.toHaveProperty('sound');
  });

  it("passes a ring's expiry and sound through to Expo (#189)", async () => {
    const { sender, client } = senderWith(() => ok('receipt'));

    await sender.send([
      {
        ...envelope('ExponentPushToken[gggg]'),
        data: { kind: 'call-incoming', orderId: '0199c0de-0000-7000-8000-000000000001' },
        channelId: 'calls',
        ttlSeconds: 30,
        sound: 'default',
      },
    ]);

    expect(client.chunksSent[0]?.[0]).toMatchObject({
      priority: 'high',
      channelId: 'calls',
      ttl: 30,
      sound: 'default',
    });
  });

  it('lets a whole-request failure escape, so the job is retried rather than lost', async () => {
    const client: ExpoPushClient = {
      chunkPushNotifications: (messages: ExpoPushMessage[]) => [messages],
      sendPushNotificationsAsync: () => Promise.reject(new Error('socket hang up')),
      chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
      getPushNotificationReceiptsAsync: () => Promise.reject(new Error('socket hang up')),
    };
    const sender = new ExpoPushSender(client);

    await expect(sender.send([envelope('ExponentPushToken[eeee]')])).rejects.toThrow(
      'socket hang up',
    );
  });

  describe('receipts (issue #142)', () => {
    function withReceipts(receipts: Record<string, ExpoPushReceipt>): {
      sender: ExpoPushSender;
      client: FakeExpo;
    } {
      const built = senderWith(() => ({ status: 'ok', id: 'unused' }));
      for (const [id, receipt] of Object.entries(receipts)) {
        built.client.receipts.set(id, receipt);
      }
      return built;
    }

    it('reports a delivered push as delivered', async () => {
      const { sender } = withReceipts({ r1: { status: 'ok' } });

      const resolved = await sender.fetchReceipts(['r1']);

      expect(resolved.get('r1')).toEqual({ status: 'delivered' });
    });

    /**
     * **The one outcome that costs a device its registration.** Nothing else
     * in this table may reach it, which is what the rest of these cases exist
     * to pin down.
     */
    it('reports a gone install as unreachable', async () => {
      const { sender } = withReceipts({
        r1: {
          status: 'error',
          message: 'not registered',
          details: { error: 'DeviceNotRegistered' },
        },
      });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({ status: 'unreachable' });
    });

    it('tells a credentials failure apart from a dead device', async () => {
      const { sender } = withReceipts({
        r1: { status: 'error', message: 'bad creds', details: { error: 'InvalidCredentials' } },
      });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
        status: 'credentials',
        code: 'InvalidCredentials',
        message: 'bad creds',
      });
    });

    /**
     * Documented and **absent from the SDK's union**, which is exactly why it
     * is worth a test: a `switch` over the narrow type would fall through to
     * the default and treat a configuration fault as an unknown code.
     */
    it('treats MismatchSenderId as a credentials fault, though the SDK does not type it', async () => {
      const { sender } = withReceipts({
        r1: {
          status: 'error',
          message: 'fcm mismatch',
          details: { error: 'MismatchSenderId' as 'InvalidCredentials' },
        },
      });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
        status: 'credentials',
        code: 'MismatchSenderId',
        message: 'fcm mismatch',
      });
    });

    it('reports an oversized payload as a bug on this side', async () => {
      const { sender } = withReceipts({
        r1: { status: 'error', message: 'nope', details: { error: 'MessageTooBig' } },
      });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
        status: 'sender-error',
        code: 'MessageTooBig',
        message: 'nope',
      });
    });

    it('reports the one code Expo says to retry as transient', async () => {
      const { sender } = withReceipts({
        r1: { status: 'error', message: 'later', details: { error: 'MessageRateExceeded' } },
      });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
        status: 'transient',
        code: 'MessageRateExceeded',
        message: 'later',
      });
    });

    /**
     * The three codes `expo-server-sdk@7.2.0` types and no Expo documentation
     * defines. Naming them here is the record that the silence was checked
     * rather than overlooked — if Expo ever documents them, this test is what
     * fails and asks for a decision.
     */
    it.each(['DeveloperError', 'ExpoError', 'ProviderError'] as const)(
      'leaves %s alone, because nothing official says what it means',
      async (error) => {
        const { sender } = withReceipts({
          r1: { status: 'error', message: 'undocumented', details: { error } },
        });

        expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
          status: 'unknown',
          code: error,
          message: 'undocumented',
        });
      },
    );

    /**
     * A code the vendor adds after this release ships. Retiring a device on a
     * word nobody has read is how a working install stops receiving anything,
     * with no error anywhere to explain it.
     */
    it('never retires a device on a code it does not recognise', async () => {
      const { sender } = withReceipts({
        r1: {
          status: 'error',
          message: 'something new',
          details: { error: 'SomethingExpoAddedLater' as 'ExpoError' },
        },
      });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
        status: 'unknown',
        code: 'SomethingExpoAddedLater',
        message: 'something new',
      });
    });

    it('treats an error with no code at all as unknown, not as a dead device', async () => {
      const { sender } = withReceipts({ r1: { status: 'error', message: 'bare' } });

      expect((await sender.fetchReceipts(['r1'])).get('r1')).toEqual({
        status: 'unknown',
        code: 'UnknownExpoError',
        message: 'bare',
      });
    });

    /**
     * **The distinction the whole sweep rests on.** Expo omits a receipt it
     * has not produced yet, and a caller that read the gap as a verdict would
     * drop the worklist row before its answer existed.
     */
    it('leaves a receipt Expo has not produced out of the answer entirely', async () => {
      const { sender } = withReceipts({ r1: { status: 'ok' } });

      const resolved = await sender.fetchReceipts(['r1', 'r2']);

      expect(resolved.has('r1')).toBe(true);
      expect(resolved.has('r2')).toBe(false);
      expect(resolved.size).toBe(1);
    });

    it('asks for nothing when there is nothing to ask about', async () => {
      const { sender, client } = withReceipts({});

      expect((await sender.fetchReceipts([])).size).toBe(0);
      expect(client.receiptChunksAsked).toEqual([]);
    });

    it('chunks a run longer than the provider accepts', async () => {
      const { sender, client } = withReceipts({});
      const ids = Array.from({ length: 700 }, (_, i) => `r${String(i)}`);

      await sender.fetchReceipts(ids);

      expect(client.receiptChunksAsked.map((chunk) => chunk.length)).toEqual([300, 300, 100]);
    });

    it('lets a whole-request failure escape, so the sweep leaves its rows alone', async () => {
      const client: ExpoPushClient = {
        chunkPushNotifications: (messages: ExpoPushMessage[]) => [messages],
        sendPushNotificationsAsync: () => Promise.resolve([]),
        chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
        getPushNotificationReceiptsAsync: () => Promise.reject(new Error('socket hang up')),
      };

      await expect(new ExpoPushSender(client).fetchReceipts(['r1'])).rejects.toThrow(
        'socket hang up',
      );
    });
  });
});
