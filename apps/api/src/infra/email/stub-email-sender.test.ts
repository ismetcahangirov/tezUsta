import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MockInstance } from 'vitest';

import { spyOnEveryLogSink } from '../../../test/support/log-sink';
import { StubEmailSender, StubEmailSenderInProductionError } from './stub-email-sender';

const MESSAGE = {
  to: 'ali.veli@example.com',
  subject: 'TezUsta giriş kodu',
  text: 'TezUsta kodunuz: 123456',
};

describe('StubEmailSender', () => {
  let sink: string[];
  let spies: MockInstance[];

  beforeEach(() => {
    sink = [];
    spies = spyOnEveryLogSink(sink);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('refuses to be constructed in production', () => {
    // A deploy configured with EMAIL_PROVIDER=stub fails during
    // NestFactory.create with a message naming the problem, instead of booting
    // green and silently sending nobody a code.
    expect(() => new StubEmailSender('production')).toThrow(StubEmailSenderInProductionError);
  });

  it('explains what to do, not just that it refused', () => {
    try {
      new StubEmailSender('production');
      throw new Error('expected the constructor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StubEmailSenderInProductionError);
      expect((error as Error).message).toContain('ADR-0072');
      expect((error as Error).message).toContain('real provider');
    }
  });

  it('prints the message in development, because there is no inbox to receive it', async () => {
    await new StubEmailSender('development').send(MESSAGE);

    expect(sink.join('\n')).toContain(MESSAGE.text);
  });

  it('masks the recipient even in development', async () => {
    await new StubEmailSender('development').send(MESSAGE);

    const combined = sink.join('\n');
    expect(combined).not.toContain('ali.veli');
    expect(combined).toContain('a•••@example.com');
  });

  it('prints nothing at all under NODE_ENV=test', async () => {
    // Positive control first: the development sender prints, so the sink
    // demonstrably captures what this stub writes (#127).
    await new StubEmailSender('development').send(MESSAGE);
    expect(sink.join('\n')).toContain(MESSAGE.text);
    sink.length = 0;

    await new StubEmailSender('test').send(MESSAGE);

    expect(sink).toHaveLength(0);
  });

  it('resolves rather than throwing, so a caller cannot tell it apart from a real send', async () => {
    await expect(new StubEmailSender('test').send(MESSAGE)).resolves.toBeUndefined();
  });
});
