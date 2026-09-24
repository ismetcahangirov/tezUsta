import { createHash } from 'node:crypto';

import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MockInstance } from 'vitest';

import { describeCallMediaContract } from '../../../test/support/call-media-contract';
import type { CallMediaHarness } from '../../../test/support/call-media-contract';
import { expectLoggerIsListening, spyOnEveryLogSink } from '../../../test/support/log-sink';
import type { CallMediaEvent, JoinCredential, WebhookDelivery } from './call-media.types';
import { CallMediaUnavailableError } from './call-media.types';
import { LiveKitCallMediaProvider } from './livekit-call-media.provider';
import type { LiveKitCallMediaConfig } from './livekit-call-media.provider';

/**
 * These run against the LiveKit in `docker compose` locally and the `livekit`
 * service container in CI — a real server, because the only thing a stub
 * cannot prove is that LiveKit accepts what this adapter mints.
 *
 * The connection comes from `test/setup-env.ts`, which defaults it to the
 * committed development key pair. **Absent a server this suite fails; it does
 * not skip** — the `beforeAll` below says so in words — for the reason every
 * Postgres-backed suite gives: a test that skips when its dependency is
 * missing is a test CI can be green without running (CLAUDE.md §13).
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set — test/setup-env.ts should have defaulted it`);
  }
  return value;
}

const CONFIG: LiveKitCallMediaConfig = {
  publicUrl: requiredEnv('LIVEKIT_URL'),
  apiUrl: requiredEnv('LIVEKIT_URL').replace(/^ws(s?):/, 'http$1:'),
  apiKey: requiredEnv('LIVEKIT_API_KEY'),
  apiSecret: requiredEnv('LIVEKIT_API_SECRET'),
  joinTokenTtlSeconds: 600,
};

/**
 * Joins the way a phone's SDK does: the signalling socket at `/rtc`, with the
 * token on the query string. The server answers an admitted participant with
 * its join response as the first message, and refuses a bad token at the HTTP
 * upgrade — which a WebSocket reports as an error before `open`.
 *
 * No WebRTC is negotiated, so nobody publishes audio. The participant is still
 * real to LiveKit: it appears in `ListParticipants`, and `DeleteRoom` closes
 * this socket from the server side.
 */
function joinAsPhone(credential: JoinCredential): Promise<{ leave(): void }> {
  const url = new URL('/rtc', credential.url);
  url.searchParams.set('access_token', credential.token);
  url.searchParams.set('protocol', '16');
  url.searchParams.set('sdk', 'js');
  url.searchParams.set('auto_subscribe', '1');

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let admitted = false;
    const leave = (): void => {
      socket.close();
    };
    socket.addEventListener('message', () => {
      if (!admitted) {
        admitted = true;
        resolve({ leave });
      }
    });
    const refuse = (): void => {
      if (!admitted) {
        admitted = true;
        reject(new Error('LiveKit refused the join'));
      }
    };
    socket.addEventListener('error', refuse);
    socket.addEventListener('close', refuse);
  });
}

/**
 * A webhook exactly as LiveKit sends one: the protobuf-JSON event as the body,
 * and as `Authorization` a JWT signed with the API secret whose `sha256` claim
 * is the base64 SHA-256 of that body — the scheme `WebhookReceiver.receive`
 * verifies, read from the shipped `dist/WebhookReceiver.js`.
 */
async function signAsLiveKit(body: object, secret: string): Promise<WebhookDelivery> {
  const text = JSON.stringify(body);
  const token = new AccessToken(CONFIG.apiKey, secret);
  token.sha256 = createHash('sha256').update(text).digest('base64');
  return { body: text, authorization: await token.toJwt() };
}

function toLiveKitBody(event: CallMediaEvent): object {
  const base = {
    id: event.eventId,
    createdAt: String(event.createdAt.getTime() / 1000),
    room: { name: event.roomName },
  };
  switch (event.type) {
    case 'room-finished':
      return { ...base, event: 'room_finished' };
    case 'participant-joined':
      return {
        ...base,
        event: 'participant_joined',
        participant: { identity: event.participantIdentity },
      };
    case 'participant-left':
      return {
        ...base,
        event: 'participant_left',
        participant: { identity: event.participantIdentity },
      };
  }
}

const FOREIGN_SECRET = 'a-different-livekit-secret-0123456789abcdef';

function liveKitHarness(provider: LiveKitCallMediaProvider): CallMediaHarness {
  return {
    provider,
    joinTokenTtlSeconds: CONFIG.joinTokenTtlSeconds,
    join: joinAsPhone,
    deliver: (event) => signAsLiveKit(toLiveKitBody(event), CONFIG.apiSecret),
    deliverUnhandled: (eventId, createdAt, roomName) =>
      signAsLiveKit(
        {
          event: 'room_started',
          id: eventId,
          createdAt: String(createdAt.getTime() / 1000),
          room: { name: roomName },
        },
        CONFIG.apiSecret,
      ),
    deliverForged: (event) => signAsLiveKit(toLiveKitBody(event), FOREIGN_SECRET),
  };
}

describe('LiveKitCallMediaProvider (issue #184)', () => {
  const provider = new LiveKitCallMediaProvider(CONFIG);
  const harness = liveKitHarness(provider);

  beforeAll(async () => {
    try {
      await provider.listRooms();
    } catch (error) {
      throw new Error(
        `LiveKit is not reachable at ${CONFIG.apiUrl}. Run \`docker compose up -d\` — this ` +
          'suite fails rather than skips without it.',
        { cause: error },
      );
    }
  });

  describeCallMediaContract('LiveKit', () => harness);

  describe('the token it mints', () => {
    async function claimsOf(credential: JoinCredential) {
      // Verified with the SDK's own verifier and our secret, not merely
      // decoded: a claim read from a token that does not verify proves
      // nothing about what LiveKit would accept.
      return new TokenVerifier(CONFIG.apiKey, CONFIG.apiSecret).verify(credential.token);
    }

    it('grants joining, publishing and subscribing explicitly — and nothing wider', async () => {
      const credential = await provider.mintJoinToken({
        roomName: 'call-room-a',
        identity: 'user-a',
      });

      const claims = await claimsOf(credential);

      expect(claims.video).toEqual({
        room: 'call-room-a',
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishSources: ['microphone'],
        canPublishData: false,
        canUpdateOwnMetadata: false,
      });
      // Named individually as well: `toEqual` would pass if a grant were
      // present as `undefined`, and "explicitly true" is the requirement.
      expect(claims.video?.roomJoin).toBe(true);
      expect(claims.video?.canPublish).toBe(true);
      expect(claims.video?.canSubscribe).toBe(true);
      // No administrative grant of any kind rides along.
      expect(claims.video?.roomAdmin).toBeUndefined();
      expect(claims.video?.roomCreate).toBeUndefined();
      expect(claims.video?.roomList).toBeUndefined();
      expect(claims.video?.roomRecord).toBeUndefined();
      expect(claims.sip).toBeUndefined();
    });

    it('is scoped to one identity, issued under our key, and expires when it says', async () => {
      const credential = await provider.mintJoinToken({
        roomName: 'call-room-a',
        identity: 'user-a',
      });

      const claims = await claimsOf(credential);

      expect(claims.sub).toBe('user-a');
      expect(claims.iss).toBe(CONFIG.apiKey);
      expect(claims.exp).toBe(credential.expiresAt.getTime() / 1000);
      expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(CONFIG.joinTokenTtlSeconds);
    });

    it('hands out the public URL, not the one this process calls', async () => {
      const split = new LiveKitCallMediaProvider({
        ...CONFIG,
        publicUrl: 'wss://calls.example.test',
      });

      const credential = await split.mintJoinToken({ roomName: 'room', identity: 'user' });

      expect(credential.url).toBe('wss://calls.example.test');
    });

    it('is refused by LiveKit when signed with a secret LiveKit does not hold', async () => {
      const impostor = new LiveKitCallMediaProvider({ ...CONFIG, apiSecret: FOREIGN_SECRET });

      await expect(
        joinAsPhone(await impostor.mintJoinToken({ roomName: 'room', identity: 'user' })),
      ).rejects.toThrow('refused');
    });
  });

  describe('when LiveKit cannot be asked', () => {
    // Port 9 is the discard service — nothing listens on it on a developer
    // machine or a runner, so the connection is refused at once.
    const unreachable = new LiveKitCallMediaProvider({ ...CONFIG, apiUrl: 'http://127.0.0.1:9' });

    it('throws CallMediaUnavailableError — never an empty list — from every server call', async () => {
      // The distinction #186's reaper depends on: "no rooms" ends calls,
      // "could not ask" must not.
      await expect(unreachable.listRooms()).rejects.toBeInstanceOf(CallMediaUnavailableError);
      await expect(unreachable.listParticipants('room')).rejects.toBeInstanceOf(
        CallMediaUnavailableError,
      );
      await expect(unreachable.deleteRoom('room')).rejects.toBeInstanceOf(
        CallMediaUnavailableError,
      );
    });

    it('treats a refused credential as "could not ask", not as an answer', async () => {
      const wrongSecret = new LiveKitCallMediaProvider({ ...CONFIG, apiSecret: FOREIGN_SECRET });

      await expect(wrongSecret.listRooms()).rejects.toBeInstanceOf(CallMediaUnavailableError);
    });

    it('still mints, because minting never contacts the server', async () => {
      await expect(
        unreachable.mintJoinToken({ roomName: 'room', identity: 'user' }),
      ).resolves.toEqual(expect.objectContaining({ url: CONFIG.publicUrl }));
    });
  });

  describe('logging (#127)', () => {
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

    it('writes no token, no secret and no signature to any log line, on any path', async () => {
      expectLoggerIsListening(sink, 'LiveKitCallMediaProviderTest');

      const credential = await provider.mintJoinToken({ roomName: 'room', identity: 'user' });
      const event: CallMediaEvent = {
        type: 'room-finished',
        eventId: 'EV_log',
        createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
        roomName: 'room',
      };
      const genuine = await harness.deliver(event);
      const forged = await harness.deliverForged(event);
      await provider.verifyWebhook(genuine);
      await provider.verifyWebhook(forged);
      await provider.verifyWebhook({ body: genuine.body, authorization: undefined });
      await provider
        .listRooms()
        .then(() => undefined)
        .catch(() => undefined);
      await new LiveKitCallMediaProvider({ ...CONFIG, apiUrl: 'http://127.0.0.1:9' })
        .listRooms()
        .catch(() => undefined);

      const logged = sink.join('\n');

      // Positive control on the adapter's own line: a discarded webhook is
      // logged, so the paths above demonstrably reach the sink. Without it,
      // every `not.toContain` below would hold for a harness that captured
      // nothing — the failure #127 exists to rule out.
      expect(logged).toContain('Discarded a call-media webhook');

      const secrets = [
        credential.token,
        // A JWT's signature segment alone is enough to be worth nothing to
        // leak, but its payload names the room and grants; neither belongs
        // in a log.
        ...credential.token.split('.').slice(1),
        CONFIG.apiSecret,
        genuine.authorization ?? '',
        forged.authorization ?? '',
        FOREIGN_SECRET,
      ];
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(0);
        expect(logged).not.toContain(secret);
      }
    });
  });
});
