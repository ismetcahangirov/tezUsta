import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MockInstance } from 'vitest';

import { describeCallMediaContract } from '../../../test/support/call-media-contract';
import type { CallMediaHarness } from '../../../test/support/call-media-contract';
import { expectLoggerIsListening, spyOnEveryLogSink } from '../../../test/support/log-sink';
import type { CallMediaEvent } from './call-media.types';
import {
  StubCallMediaProvider,
  StubCallMediaProviderInProductionError,
} from './stub-call-media.provider';

const TTL_SECONDS = 600;

function stubHarness(provider: StubCallMediaProvider): CallMediaHarness {
  const deliverAs = (signer: StubCallMediaProvider, event: object) => {
    const body = JSON.stringify(event);
    return Promise.resolve({ body, authorization: signer.signWebhook(body) });
  };

  return {
    provider,
    joinTokenTtlSeconds: TTL_SECONDS,
    // Deferred into a promise so a refused join rejects, as a real
    // connection does, rather than throwing synchronously.
    join: (credential) => Promise.resolve().then(() => provider.join(credential.token)),
    deliver: (event: CallMediaEvent) => deliverAs(provider, event),
    deliverUnhandled: (eventId, createdAt, roomName) =>
      deliverAs(provider, { type: 'room-started', eventId, createdAt, roomName }),
    deliverForged: (event) => deliverAs(new StubCallMediaProvider('test', TTL_SECONDS), event),
  };
}

describe('StubCallMediaProvider (issue #184)', () => {
  let harness: CallMediaHarness;

  beforeEach(() => {
    harness = stubHarness(new StubCallMediaProvider('test', TTL_SECONDS));
  });

  describeCallMediaContract('the stub', () => harness);

  it('refuses to construct in production', () => {
    // The whole control. A runtime guard would boot green and hand every
    // accepted call a token no media server honours — the stub push sender,
    // SMS sender and storage provider refuse for the same reason.
    expect(() => new StubCallMediaProvider('production', TTL_SECONDS)).toThrow(
      StubCallMediaProviderInProductionError,
    );
  });

  it('says which variable to set, not only that it refused', () => {
    expect(() => new StubCallMediaProvider('production', TTL_SECONDS)).toThrow(
      /CALLS_PROVIDER=livekit/,
    );
  });

  it.each(['development', 'test'] as const)('constructs under %s', (nodeEnv) => {
    expect(() => new StubCallMediaProvider(nodeEnv, TTL_SECONDS)).not.toThrow();
  });

  it('can fail every server call the way an unreachable media server does', async () => {
    // What #186's reaper needs to tell "could not ask" from "no rooms"
    // without stopping a container. Minting is local on LiveKit too, so it
    // is deliberately unaffected.
    const provider = new StubCallMediaProvider('test', TTL_SECONDS);
    provider.failWith = new Error('no route to host');

    await expect(provider.listRooms()).rejects.toThrow('no route to host');
    await expect(provider.listParticipants('room')).rejects.toThrow('no route to host');
    await expect(provider.deleteRoom('room')).rejects.toThrow('no route to host');
    await expect(provider.mintJoinToken({ roomName: 'room', identity: 'caller' })).resolves.toEqual(
      expect.objectContaining({ url: 'stub://calls' }),
    );
  });

  it('forgets its rooms and its failure on reset', async () => {
    const provider = new StubCallMediaProvider('test', TTL_SECONDS);
    provider.join((await provider.mintJoinToken({ roomName: 'room', identity: 'caller' })).token);
    provider.failWith = new Error('down');

    provider.reset();

    expect(await provider.listRooms()).toEqual([]);
  });

  describe('logging', () => {
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

    it('names the room and the identity in development, and never prints the token', async () => {
      expectLoggerIsListening(sink, 'StubCallMediaProviderTest');
      const provider = new StubCallMediaProvider('development', TTL_SECONDS);

      const { token } = await provider.mintJoinToken({ roomName: 'call-42', identity: 'user-7' });

      // Positive control on the stub's own line (#127): it proves the path
      // writes what the negative assertion below assumes it writes.
      expect(sink.join('\n')).toContain('join token minted for user-7 in call-42');
      expect(sink.join('\n')).not.toContain(token);
      // The payload and the signature separately, too: a log that printed
      // either half of the token would still hand most of it over.
      for (const part of token.split('.').slice(1)) {
        expect(sink.join('\n')).not.toContain(part);
      }
    });

    it('prints nothing at all under NODE_ENV=test', async () => {
      expectLoggerIsListening(sink, 'StubCallMediaProviderTest');

      await new StubCallMediaProvider('test', TTL_SECONDS).mintJoinToken({
        roomName: 'call-42',
        identity: 'user-7',
      });

      expect(sink).toHaveLength(0);
    });
  });
});
