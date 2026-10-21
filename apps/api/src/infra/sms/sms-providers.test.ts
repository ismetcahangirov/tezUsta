import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AzerbaijanOnlySmsSender, SmsRecipientRefusedError } from './azerbaijan-only-sms-sender';
import { FailoverSmsSender } from './failover-sms-sender';
import { PlivoSmsSender } from './plivo-sms-sender';
import type { OutboundSms, SmsSender } from './sms-sender.types';
import type { SmsFetch } from './sms-http';
import { SmsProviderError } from './sms-http';
import { TwilioSmsSender } from './twilio-sms-sender';

const MESSAGE: OutboundSms = {
  to: '+994501234567',
  body: '482913 is your TezUsta code. It expires in 5 minutes. Do not share it.',
};
const CODE = '482913';

interface Captured {
  url: string;
  init: RequestInit;
}

/** A provider that answers `status` with `json`, and records what it was sent. */
function provider(status: number, json: unknown): { fetch: SmsFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(json), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

/** A provider that never answers, until the caller gives up on it. */
const silent: SmsFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    });
  });

/** Everything every logger wrote during a test, as one string. */
function captureLogs(): () => string {
  const lines: string[] = [];
  const record = (message: unknown): void => {
    lines.push(String(message));
  };
  vi.spyOn(Logger.prototype, 'log').mockImplementation(record);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(record);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(record);
  return () => lines.join('\n');
}

/** The error a send rejected with. */
async function failureOf(sending: Promise<void>): Promise<Error> {
  try {
    await sending;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('the send rejected with something other than an Error', { cause: error });
  }
  throw new Error('the send was expected to fail');
}

function expectNothingSecret(text: string): void {
  expect(text).not.toContain(CODE);
  expect(text).not.toContain(MESSAGE.to);
  expect(text).not.toContain(MESSAGE.to.slice(1));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlivoSmsSender (#390)', () => {
  const settings = {
    authId: 'MAXXXX',
    authToken: 'secret-token',
    senderId: 'TezUsta',
    timeoutMs: 50,
  };

  it('posts src, dst and text as JSON with Basic auth, and logs only the id and a masked number', async () => {
    const logs = captureLogs();
    const fake = provider(202, { message: 'message(s) queued', message_uuid: ['uuid-1'] });

    await new PlivoSmsSender(settings, fake.fetch).send(MESSAGE);

    const [call] = fake.calls;
    expect(call?.url).toBe('https://api.plivo.com/v1/Account/MAXXXX/Message/');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('MAXXXX:secret-token').toString('base64')}`,
    );
    expect(JSON.parse(call?.init.body as string)).toEqual({
      src: 'TezUsta',
      dst: '+994501234567',
      text: MESSAGE.body,
    });
    expect(logs()).toContain('id=uuid-1');
    expectNothingSecret(logs());
  });

  it('throws on a provider error, with nothing from the request or response in it', async () => {
    const fake = provider(401, { error: `unauthorised for ${MESSAGE.to}: ${MESSAGE.body}` });

    const error = await failureOf(new PlivoSmsSender(settings, fake.fetch).send(MESSAGE));

    expect(error).toBeInstanceOf(SmsProviderError);
    expect(error.message).toContain('HTTP 401');
    expectNothingSecret(error.message);
  });

  it('gives up on a provider that does not answer in time', async () => {
    await expect(new PlivoSmsSender(settings, silent).send(MESSAGE)).rejects.toThrow('timed out');
  });
});

describe('TwilioSmsSender (#390)', () => {
  const settings = {
    accountSid: 'ACXXXX',
    authToken: 'secret-token',
    senderId: 'TezUsta',
    timeoutMs: 50,
  };

  it('posts To, From and Body form-encoded with Basic auth, and logs only the sid', async () => {
    const logs = captureLogs();
    const fake = provider(201, { sid: 'SM123' });

    await new TwilioSmsSender(settings, fake.fetch).send(MESSAGE);

    const [call] = fake.calls;
    expect(call?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACXXXX/Messages.json');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('ACXXXX:secret-token').toString('base64')}`,
    );
    const form = new URLSearchParams(call?.init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      To: '+994501234567',
      From: 'TezUsta',
      Body: MESSAGE.body,
    });
    expect(logs()).toContain('id=SM123');
    expectNothingSecret(logs());
  });

  it('throws on a provider error, with nothing secret in it', async () => {
    const fake = provider(400, { code: 21211, message: `Invalid To ${MESSAGE.to}` });

    const error = await failureOf(new TwilioSmsSender(settings, fake.fetch).send(MESSAGE));

    expect(error).toBeInstanceOf(SmsProviderError);
    expect(error.message).toContain('HTTP 400');
    expectNothingSecret(error.message);
  });

  it('gives up on a provider that does not answer in time', async () => {
    await expect(new TwilioSmsSender(settings, silent).send(MESSAGE)).rejects.toThrow('timed out');
  });
});

/** A sender that succeeds or fails, and the spy that counts its sends. */
function sender(outcome: 'ok' | Error): SmsSender & { readonly calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn((message: OutboundSms) => {
    void message;
    return outcome === 'ok' ? Promise.resolve() : Promise.reject(outcome);
  });
  return { calls, send: (message) => calls(message) };
}

describe('FailoverSmsSender (#390)', () => {
  it('sends once through the primary when it succeeds', async () => {
    const primary = sender('ok');
    const fallback = sender('ok');

    await new FailoverSmsSender(primary, fallback).send(MESSAGE);

    expect(primary.calls).toHaveBeenCalledOnce();
    expect(fallback.calls).not.toHaveBeenCalled();
  });

  it('falls back when the primary fails, and logs nothing secret', async () => {
    const logs = captureLogs();
    const primary = sender(new SmsProviderError('plivo', 'timed out'));
    const fallback = sender('ok');

    await new FailoverSmsSender(primary, fallback).send(MESSAGE);

    expect(fallback.calls).toHaveBeenCalledWith(MESSAGE);
    expect(logs()).toContain('plivo did not accept the message: timed out');
    expectNothingSecret(logs());
  });

  it('names only the class of an error that is not its own', async () => {
    const logs = captureLogs();
    const primary = sender(new Error(`request ${MESSAGE.body} to ${MESSAGE.to} failed`));

    await new FailoverSmsSender(primary, sender('ok')).send(MESSAGE);

    expectNothingSecret(logs());
  });

  it('throws when both fail', async () => {
    captureLogs();
    const failover = new FailoverSmsSender(
      sender(new SmsProviderError('plivo', 'HTTP 500')),
      sender(new SmsProviderError('twilio', 'HTTP 503')),
    );

    await expect(failover.send(MESSAGE)).rejects.toThrow('twilio did not accept');
  });
});

describe('AzerbaijanOnlySmsSender (#390)', () => {
  it('sends to a +994 mobile', async () => {
    const inner = sender('ok');

    await new AzerbaijanOnlySmsSender(inner).send(MESSAGE);

    expect(inner.calls).toHaveBeenCalledOnce();
  });

  it.each([
    ['a foreign number', '+79161234567'],
    ['a Baku landline', '+994124567890'],
  ])('refuses %s before any provider is called', async (_case, to) => {
    const inner = sender('ok');

    await expect(
      new AzerbaijanOnlySmsSender(inner).send({ ...MESSAGE, to }),
    ).rejects.toBeInstanceOf(SmsRecipientRefusedError);
    expect(inner.calls).not.toHaveBeenCalled();
  });
});
