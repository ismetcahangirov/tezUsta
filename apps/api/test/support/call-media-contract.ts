import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CallMediaEvent,
  CallMediaProvider,
  JoinCredential,
  WebhookDelivery,
} from '../../src/infra/calls/call-media.types';

/**
 * What the contract needs from an implementation beyond the port itself: a way
 * to do what the *other side* of the port does — a phone joining a room, the
 * media server delivering a webhook.
 *
 * Each implementation supplies its own, in its own wire format. That is the
 * point: the suite never learns what a LiveKit webhook body looks like, so it
 * cannot accidentally hold the stub to LiveKit's format or LiveKit to the
 * stub's. It holds both to what the port promises.
 */
export interface CallMediaHarness {
  readonly provider: CallMediaProvider;
  /** The `CALL_JOIN_TOKEN_TTL_SECONDS` the provider was built with. */
  readonly joinTokenTtlSeconds: number;
  /**
   * Connects with `credential` the way a phone would, and resolves once the
   * server has admitted it. **Rejects** when the server refuses the token.
   */
  join(credential: JoinCredential): Promise<{ leave(): void }>;
  /** Encodes `event` and signs it exactly as the real server would deliver it. */
  deliver(event: CallMediaEvent): Promise<WebhookDelivery>;
  /** A signed delivery of an event the port does not surface — a room starting. */
  deliverUnhandled(eventId: string, createdAt: Date, roomName: string): Promise<WebhookDelivery>;
  /** `event`, signed correctly — but with a key this provider does not hold. */
  deliverForged(event: CallMediaEvent): Promise<WebhookDelivery>;
}

/**
 * Polls until `check` stops throwing. A real media server applies a join or a
 * delete a moment after it answers, and a contract that assumed otherwise
 * would be a contract only the stub could keep.
 */
async function eventually(check: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Whole seconds: LiveKit's webhook timestamps have no finer resolution. */
function wholeSecondsAgo(seconds: number): Date {
  return new Date((Math.floor(Date.now() / 1000) - seconds) * 1000);
}

/**
 * The port's promises (issue #184), run against every implementation of it.
 *
 * A room name is fresh per test, never a constant: CI and a developer's
 * `pnpm test` can share one LiveKit, and `listRooms` answers for the whole
 * server. Assertions are therefore "contains" and "does not contain", never
 * "equals".
 */
export function describeCallMediaContract(
  implementation: string,
  harness: () => CallMediaHarness,
): void {
  describe(`${implementation} keeps the CallMediaProvider contract`, () => {
    const joined: { leave(): void }[] = [];
    const rooms: string[] = [];

    function room(): string {
      const name = `contract-${randomUUID()}`;
      rooms.push(name);
      return name;
    }

    async function join(credential: JoinCredential): Promise<void> {
      joined.push(await harness().join(credential));
    }

    afterEach(async () => {
      vi.useRealTimers();
      for (const connection of joined.splice(0)) {
        connection.leave();
      }
      for (const name of rooms.splice(0)) {
        await harness().provider.deleteRoom(name);
      }
    });

    describe('join tokens', () => {
      it('mints a credential that expires within the configured lifetime', async () => {
        const { provider, joinTokenTtlSeconds } = harness();
        const before = Date.now();

        const credential = await provider.mintJoinToken({ roomName: room(), identity: 'caller' });

        expect(credential.token.length).toBeGreaterThan(0);
        expect(credential.url.length).toBeGreaterThan(0);
        // One second of slack either side: `exp` is whole seconds.
        expect(credential.expiresAt.getTime()).toBeGreaterThan(before);
        expect(credential.expiresAt.getTime()).toBeLessThanOrEqual(
          Date.now() + joinTokenTtlSeconds * 1000 + 1000,
        );
        expect(credential.expiresAt.getTime()).toBeGreaterThanOrEqual(
          before + joinTokenTtlSeconds * 1000 - 1000,
        );
      });

      it('refuses to mint for an empty room name or identity', async () => {
        const { provider } = harness();

        await expect(provider.mintJoinToken({ roomName: '', identity: 'caller' })).rejects.toThrow(
          TypeError,
        );
        await expect(provider.mintJoinToken({ roomName: room(), identity: '' })).rejects.toThrow(
          TypeError,
        );
      });

      it('joins its own room as its own identity, and appears in no other room', async () => {
        const { provider } = harness();
        const own = room();
        const other = room();

        await join(await provider.mintJoinToken({ roomName: own, identity: 'caller' }));

        await eventually(async () => {
          const participants = await provider.listParticipants(own);
          expect(participants.map((p) => p.identity)).toEqual(['caller']);
        });
        expect(await provider.listParticipants(other)).toEqual([]);

        const live = (await provider.listRooms()).map((r) => r.name);
        expect(live).toContain(own);
        expect(live).not.toContain(other);
      });

      it('reports when a participant joined and when the room was created', async () => {
        const { provider } = harness();
        const name = room();
        const before = wholeSecondsAgo(1).getTime();

        await join(await provider.mintJoinToken({ roomName: name, identity: 'caller' }));

        await eventually(async () => {
          const [participant] = await provider.listParticipants(name);
          expect(participant?.joinedAt.getTime()).toBeGreaterThanOrEqual(before);
        });
        const created = (await provider.listRooms()).find((r) => r.name === name);
        expect(created?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      });

      it('is refused once it has expired', async () => {
        const { provider } = harness();

        // Minted two hours in the past, so it expired long ago by any clock
        // tolerance a server applies (LiveKit allows a minute). Only `Date`
        // is faked: the signing code reads the clock, and nothing else here
        // should notice.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000);
        const stale = await provider.mintJoinToken({ roomName: room(), identity: 'caller' });
        vi.useRealTimers();

        expect(stale.expiresAt.getTime()).toBeLessThan(Date.now());
        await expect(harness().join(stale)).rejects.toThrow();
      });

      it('is refused when it has been tampered with', async () => {
        const { provider } = harness();
        const credential = await provider.mintJoinToken({ roomName: room(), identity: 'caller' });

        // The **first** character of the signature, never the last. An HS256
        // signature is 32 bytes, 43 base64url characters, and the final
        // character carries two unused padding bits: swapping it between `A`,
        // `B`, `C` and `D` changes no decoded byte, so the "tampered" token
        // was the original about one run in sixteen and the server rightly
        // accepted it. Every bit of the first character is signature data.
        const at = credential.token.lastIndexOf('.') + 1;
        const flipped = credential.token[at] === 'A' ? 'B' : 'A';
        const tampered = `${credential.token.slice(0, at)}${flipped}${credential.token.slice(at + 1)}`;

        await expect(harness().join({ ...credential, token: tampered })).rejects.toThrow();
      });
    });

    describe('rooms', () => {
      it('answers an empty list, not an error, for a room that does not exist', async () => {
        expect(await harness().provider.listParticipants(room())).toEqual([]);
      });

      it('deletes a room, and everybody in it goes with it', async () => {
        const { provider } = harness();
        const name = room();
        await join(await provider.mintJoinToken({ roomName: name, identity: 'caller' }));
        await eventually(async () => {
          expect((await provider.listRooms()).map((r) => r.name)).toContain(name);
        });

        await provider.deleteRoom(name);

        await eventually(async () => {
          expect((await provider.listRooms()).map((r) => r.name)).not.toContain(name);
          expect(await provider.listParticipants(name)).toEqual([]);
        });
      });

      it('deletes idempotently — a room that is already gone, or never existed, resolves', async () => {
        const { provider } = harness();
        const name = room();

        await expect(provider.deleteRoom(name)).resolves.toBeUndefined();
        await expect(provider.deleteRoom(name)).resolves.toBeUndefined();
      });
    });

    describe('webhooks', () => {
      const events: readonly CallMediaEvent[] = [
        {
          type: 'room-finished',
          eventId: 'EV_room_finished',
          createdAt: wholeSecondsAgo(5),
          roomName: 'call-room',
        },
        {
          type: 'participant-joined',
          eventId: 'EV_joined',
          createdAt: wholeSecondsAgo(5),
          roomName: 'call-room',
          participantIdentity: 'caller',
        },
        {
          type: 'participant-left',
          eventId: 'EV_left',
          createdAt: wholeSecondsAgo(5),
          roomName: 'call-room',
          participantIdentity: 'callee',
        },
      ];

      it.each(events)('verifies a genuine $type and returns it field for field', async (event) => {
        const { provider } = harness();

        const result = await provider.verifyWebhook(await harness().deliver(event));

        expect(result).toEqual({ status: 'verified', event });
      });

      it('rejects a delivery with no Authorization header', async () => {
        const [event] = events;
        const delivery = await harness().deliver(event as CallMediaEvent);

        expect(
          await harness().provider.verifyWebhook({ ...delivery, authorization: undefined }),
        ).toEqual({ status: 'invalid' });
        expect(await harness().provider.verifyWebhook({ ...delivery, authorization: '' })).toEqual({
          status: 'invalid',
        });
      });

      it('rejects a delivery whose body was changed after it was signed', async () => {
        const event = events[1] as CallMediaEvent & { type: 'participant-joined' };
        const genuine = await harness().deliver(event);
        const other = await harness().deliver({ ...event, participantIdentity: 'intruder' });

        // A real signature, over a different body. What binds a signature to
        // *this* body is the point of the check.
        const result = await harness().provider.verifyWebhook({
          body: other.body,
          authorization: genuine.authorization,
        });

        expect(result).toEqual({ status: 'invalid' });
      });

      it('rejects a delivery signed with a key it does not hold', async () => {
        const [event] = events;

        const result = await harness().provider.verifyWebhook(
          await harness().deliverForged(event as CallMediaEvent),
        );

        expect(result).toEqual({ status: 'invalid' });
      });

      it('rejects a header that is not a signature at all', async () => {
        const [event] = events;
        const delivery = await harness().deliver(event as CallMediaEvent);

        const result = await harness().provider.verifyWebhook({
          ...delivery,
          authorization: 'Bearer not-a-signature',
        });

        expect(result).toEqual({ status: 'invalid' });
      });

      it('marks a genuine event it does not act on as ignored — not as invalid', async () => {
        const createdAt = wholeSecondsAgo(3);

        const result = await harness().provider.verifyWebhook(
          await harness().deliverUnhandled('EV_unhandled', createdAt, 'call-room'),
        );

        expect(result).toMatchObject({ status: 'ignored', eventId: 'EV_unhandled', createdAt });
      });
    });
  });
}
