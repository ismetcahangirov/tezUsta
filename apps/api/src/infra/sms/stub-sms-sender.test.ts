import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { StubSmsSender, StubSmsSenderInProductionError } from './stub-sms-sender';

const MESSAGE = { to: '+994501234567', body: 'TezUsta kodunuz: 123456' };

describe('StubSmsSender', () => {
  let sink: string[];
  let spies: MockInstance[];

  beforeEach(() => {
    sink = [];
    const record = (...parts: unknown[]): void => {
      sink.push(parts.map((part) => String(part)).join(' '));
    };
    // Nest's ConsoleLogger writes through `console.log`/`console.error` and,
    // for a warning, `console.warn`. All three are captured so a leak cannot
    // slip out through whichever one the logger happens to pick.
    spies = [
      vi.spyOn(console, 'log').mockImplementation(record),
      vi.spyOn(console, 'warn').mockImplementation(record),
      vi.spyOn(console, 'error').mockImplementation(record),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        record(chunk);
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        record(chunk);
        return true;
      }),
    ];
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
