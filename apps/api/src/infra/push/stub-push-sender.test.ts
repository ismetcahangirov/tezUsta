import { describe, expect, it } from 'vitest';

import { StubPushSender, StubPushSenderInProductionError } from './stub-push-sender';
import type { PushEnvelope } from './push-sender.types';

function envelope(token: string): PushEnvelope {
  return {
    pushToken: token,
    title: 'Usta tapıldı',
    body: 'Bir usta sifarişinizi qəbul etdi.',
    data: { kind: 'order-accepted' },
    channelId: 'order-accepted',
  };
}

describe('StubPushSender (issue #141)', () => {
  it('refuses to construct in production', () => {
    // The whole control. A runtime guard around the send would leave the
    // service booting, reporting green, and delivering nothing — a silent,
    // total notification outage. `StubSmsSender` refuses for the same reason.
    expect(() => new StubPushSender('production')).toThrow(StubPushSenderInProductionError);
  });

  it.each(['development', 'test'] as const)('constructs under %s', (nodeEnv) => {
    expect(() => new StubPushSender(nodeEnv)).not.toThrow();
  });

  it('records what would have gone out, in order', async () => {
    const sender = new StubPushSender('test');

    await sender.send([envelope('ExponentPushToken[a]'), envelope('ExponentPushToken[b]')]);

    expect(sender.sent.map((e) => e.pushToken)).toEqual([
      'ExponentPushToken[a]',
      'ExponentPushToken[b]',
    ]);
  });

  it('accepts by default, with a distinct receipt id per push', async () => {
    const sender = new StubPushSender('test');

    const outcomes = await sender.send([
      envelope('ExponentPushToken[a]'),
      envelope('ExponentPushToken[b]'),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);
    const ids = outcomes.map((o) => (o.status === 'accepted' ? o.receiptId : null));
    expect(new Set(ids).size).toBe(2);
  });

  it('answers an arranged outcome for the token it was arranged for, and only that one', async () => {
    const sender = new StubPushSender('test');
    sender.outcomes.set('ExponentPushToken[dead]', { status: 'unreachable' });

    const outcomes = await sender.send([
      envelope('ExponentPushToken[live]'),
      envelope('ExponentPushToken[dead]'),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(['accepted', 'unreachable']);
  });

  it('can fail the whole request, the way a network outage does', async () => {
    const sender = new StubPushSender('test');
    sender.failWith = new Error('no route to host');

    await expect(sender.send([envelope('ExponentPushToken[a]')])).rejects.toThrow(
      'no route to host',
    );
  });

  it('forgets its arrangements on reset', async () => {
    const sender = new StubPushSender('test');
    sender.outcomes.set('ExponentPushToken[a]', { status: 'unreachable' });
    await sender.send([envelope('ExponentPushToken[a]')]);

    sender.reset();

    expect(sender.sent).toEqual([]);
    const [outcome] = await sender.send([envelope('ExponentPushToken[a]')]);
    expect(outcome?.status).toBe('accepted');
  });
});
