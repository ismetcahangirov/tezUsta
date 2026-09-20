import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MockInstance } from 'vitest';

import { spyOnEveryLogSink } from '../../../test/support/log-sink';
import { StubSmsSender, StubSmsSenderInProductionError } from './stub-sms-sender';

const MESSAGE = { to: '+994501234567', body: 'TezUsta kodunuz: 123456' };

describe('StubSmsSender', () => {
  let sink: string[];
  let spies: MockInstance[];

  beforeEach(() => {
    sink = [];
    // The shared helper rather than a hand-rolled copy of it (#127): this
    // file listed five sinks and `test/support/log-sink.ts` lists seven, so
    // the day someone found a sink this one missed, only one of the two
    // learned about it.
    spies = spyOnEveryLogSink(sink);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('refuses to be constructed in production', () => {
    // ADR-0008 requires the stub to be "impossible to enable in production".
    // Refusing at construction is what makes that structural: a deploy
    // configured with SMS_PROVIDER=stub fails during NestFactory.create with a
    // message naming the problem, instead of booting green and silently
    // sending nobody a code.
    expect(() => new StubSmsSender('production')).toThrow(StubSmsSenderInProductionError);
  });

  it('explains what to do, not just that it refused', () => {
    try {
      new StubSmsSender('production');
      throw new Error('expected the constructor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StubSmsSenderInProductionError);
      expect((error as Error).message).toContain('ADR-0008');
      expect((error as Error).message).toContain('real provider');
    }
  });

  it('prints the message in development, because there is no handset to receive it', async () => {
    const sender = new StubSmsSender('development');

    await sender.send(MESSAGE);

    const combined = sink.join('\n');
    expect(combined).toContain(MESSAGE.body);
  });

  it('masks the recipient even in development', async () => {
    const sender = new StubSmsSender('development');

    await sender.send(MESSAGE);

    const combined = sink.join('\n');
    expect(combined).not.toContain('501234567');
    expect(combined).toContain('*******67');
  });

  it('prints nothing at all under NODE_ENV=test', async () => {
    // A test suite that scrolls OTP codes past a developer trains everyone to
    // expect codes in logs, which is precisely the habit ADR-0008 guards
    // against. The stub is still usable in a test — it just stays quiet.
    // Positive control, on a real line rather than a canary: the development
    // sender prints, so the sink demonstrably captures what this stub writes.
    // Without it, "prints nothing" would hold just as well for a harness that
    // captures nothing — which is the failure #127 exists to rule out.
    await new StubSmsSender('development').send(MESSAGE);
    expect(sink.join('\n')).toContain(MESSAGE.body);
    sink.length = 0;

    const sender = new StubSmsSender('test');

    await sender.send(MESSAGE);

    expect(sink.join('\n')).not.toContain(MESSAGE.body);
    expect(sink).toHaveLength(0);
  });

  it('resolves rather than throwing, so a caller cannot tell it apart from a real send', async () => {
    const sender = new StubSmsSender('test');

    await expect(sender.send(MESSAGE)).resolves.toBeUndefined();
  });
});
