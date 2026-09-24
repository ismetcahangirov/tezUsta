import { Logger } from '@nestjs/common';
import {
  AccessToken,
  RoomServiceClient,
  ServerError,
  TrackSource,
  WebhookReceiver,
} from 'livekit-server-sdk';
import type { WebhookEvent } from 'livekit-server-sdk';

import type {
  CallMediaEvent,
  CallMediaProvider,
  JoinCredential,
  JoinTokenRequest,
  LiveRoom,
  RoomParticipant,
  WebhookDelivery,
  WebhookVerification,
} from './call-media.types';
import { CallMediaUnavailableError } from './call-media.types';

export interface LiveKitCallMediaConfig {
  readonly publicUrl: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly joinTokenTtlSeconds: number;
}

/**
 * How long one RoomService request may take before it counts as a failure.
 *
 * Five seconds rather than the SDK's ten. Nothing on a request path waits on
 * RoomService today — minting is local — so the caller that feels this is the
 * reaper (#186), and a reaper that hangs for ten seconds per room behind a
 * dead server is a queue job that times out before it has learned anything.
 * Failing fast is what lets it say "could not ask" and come back.
 */
const REQUEST_TIMEOUT_SECONDS = 5;

/**
 * LiveKit, behind {@link CallMediaProvider}.
 *
 * **`infra/calls/` is the only folder that names `livekit-server-sdk`**, and
 * every value leaving this class has been copied into one of the port's own
 * shapes: a `Room` protobuf becomes a name and a date, and a webhook becomes
 * one of three events or nothing.
 *
 * The package is ESM-first (`"type": "module"`), and this API compiles to
 * CommonJS. That works without a loader or a dynamic `import()` because the
 * package ships a real dual build — its `exports` map has a `require`
 * condition pointing at `dist/index.cjs` — so `nest build` output `require`s
 * the CJS half and Vitest imports the ESM half, both from one pinned version.
 */
export class LiveKitCallMediaProvider implements CallMediaProvider {
  private readonly logger = new Logger(LiveKitCallMediaProvider.name);
  private readonly rooms: RoomServiceClient;
  private readonly webhooks: WebhookReceiver;

  constructor(private readonly config: LiveKitCallMediaConfig) {
    this.rooms = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret, {
      requestTimeout: REQUEST_TIMEOUT_SECONDS,
      // Region failover is a LiveKit Cloud feature: on a transport error the
      // SDK asks the host for its region list and replays the request
      // elsewhere. Off, because it turns "the server is down" into a slower
      // "the server is down" on a self-hosted deploy, and because the answer
      // the reaper needs from a failure is a fast one.
      failover: false,
    });
    this.webhooks = new WebhookReceiver(config.apiKey, config.apiSecret);
  }

  async mintJoinToken(request: JoinTokenRequest): Promise<JoinCredential> {
    requireName('roomName', request.roomName);
    requireName('identity', request.identity);

    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: request.identity,
      ttl: this.config.joinTokenTtlSeconds,
    });
    token.addGrant({
      room: request.roomName,
      roomJoin: true,
      // All three stated, none left to a default. LiveKit today reads an
      // absent `canPublish`/`canSubscribe` as allowed; a server-policy or SDK
      // change that flipped that would silently break calls if these were
      // omitted, or silently widen them if the default grew. Stated, a change
      // in the default changes nothing here.
      canPublish: true,
      canSubscribe: true,
      // Audio only, enforced by the media server rather than by the app's
      // good behaviour (ADR-0034 § 2, voice only). `canPublishSources`
      // supersedes `canPublish` when set, so a modified client that tries to
      // publish a camera track is refused by LiveKit itself.
      canPublishSources: [TrackSource.MICROPHONE],
      // No data channel. A call is voice between two people who already have
      // a conversation (ADR-0033) — which is moderated, persisted and
      // read-only after the order ends. A data channel would be a second,
      // unrecorded chat beside it, and nothing in EPIC 18 needs one.
      canPublishData: false,
      // A participant renaming itself, or rewriting its own metadata, would
      // let one party present as someone else inside the room.
      canUpdateOwnMetadata: false,
    });

    const jwt = await token.toJwt();
    return { token: jwt, url: this.config.publicUrl, expiresAt: readExpiry(jwt) };
  }

  async deleteRoom(roomName: string): Promise<void> {
    requireName('roomName', roomName);
    try {
      await this.rooms.deleteRoom(roomName);
    } catch (error) {
      // Observed against livekit-server 1.13.7: deleting a room that does not
      // exist answers Twirp `not_found` (HTTP 404). That is the idempotent
      // success the port promises, not a failure.
      if (isNotFound(error)) {
        return;
      }
      throw new CallMediaUnavailableError('delete a room', { cause: error });
    }
  }

  async listParticipants(roomName: string): Promise<readonly RoomParticipant[]> {
    requireName('roomName', roomName);
    try {
      const participants = await this.rooms.listParticipants(roomName);
      return participants.map((participant) => ({
        identity: participant.identity,
        joinedAt: fromEpochSeconds(participant.joinedAt),
      }));
    } catch (error) {
      // 1.13.7 answers an unknown room with an empty list, but a server that
      // answers `not_found` instead means the same thing.
      if (isNotFound(error)) {
        return [];
      }
      throw new CallMediaUnavailableError('list participants', { cause: error });
    }
  }

  async listRooms(): Promise<readonly LiveRoom[]> {
    try {
      const rooms = await this.rooms.listRooms();
      return rooms.map((room) => ({
        name: room.name,
        createdAt: fromEpochSeconds(room.creationTime),
      }));
    } catch (error) {
      // No `not_found` branch here: there is no room to be missing, and an
      // empty server answers `[]` successfully. Every failure is a failure.
      throw new CallMediaUnavailableError('list rooms', { cause: error });
    }
  }

  async verifyWebhook(delivery: WebhookDelivery): Promise<WebhookVerification> {
    if (delivery.authorization === undefined || delivery.authorization === '') {
      return this.discard('no Authorization header');
    }

    let event: WebhookEvent;
    try {
      // `skipAuth` is left at its default, `false`, and never passed. The
      // receiver checks the header's JWT signature against our secret, its
      // `exp`/`nbf` with the SDK's ten-second tolerance, and that the JWT's
      // `sha256` claim matches the body — the claim is what binds the
      // signature to *this* body rather than to any body.
      event = await this.webhooks.receive(delivery.body, delivery.authorization);
    } catch {
      // The SDK's message is deliberately not logged. Most are jose's and
      // harmless, but they are not ours to vouch for, and the reason a
      // webhook failed is not worth the risk of a header fragment in a log.
      return this.discard('the signature or the body did not verify');
    }

    return toVerification(event);
  }

  private discard(reason: string): WebhookVerification {
    // `warn`, not `error`: a forged or stale webhook is an expected input on
    // a public endpoint, not a fault in this service (#56). Still logged,
    // because a burst of them is either an attack or a key rotated on one
    // side only — and the second is an outage an operator must see.
    this.logger.warn(`Discarded a call-media webhook: ${reason}`);
    return { status: 'invalid' };
  }
}

/**
 * Turns a verified LiveKit event into ours.
 *
 * A signed event missing the field its type requires is `ignored`, not
 * `invalid`: the server did send it, so rejecting it would only make LiveKit
 * retry the same malformed event, and acting on it would mean guessing.
 */
function toVerification(event: WebhookEvent): WebhookVerification {
  const eventId = event.id;
  const createdAt = fromEpochSeconds(event.createdAt);
  const roomName = event.room?.name ?? '';
  const identity = event.participant?.identity ?? '';

  switch (event.event) {
    case 'room_finished':
      if (roomName !== '') {
        return {
          status: 'verified',
          event: { type: 'room-finished', eventId, createdAt, roomName },
        };
      }
      break;
    case 'participant_joined':
    case 'participant_left':
      if (roomName !== '' && identity !== '') {
        const type: CallMediaEvent['type'] =
          event.event === 'participant_joined' ? 'participant-joined' : 'participant-left';
        return {
          status: 'verified',
          event: { type, eventId, createdAt, roomName, participantIdentity: identity },
        };
      }
      break;
    default:
      // `participant_connection_aborted` lands here deliberately. It means a
      // participant never finished connecting — it is not a leave of someone
      // who had joined — and whether a failed connect ends a call is #185's
      // decision to make with its own timeout, not this adapter's to imply.
      break;
  }

  return { status: 'ignored', eventId, createdAt, eventName: event.event };
}

function requireName(field: string, value: string): void {
  if (value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ServerError && error.code === 'not_found';
}

/** LiveKit's protobuf timestamps are `bigint` seconds since the epoch. */
function fromEpochSeconds(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}

/**
 * The `exp` the SDK actually signed, read back out of the token.
 *
 * Computing `now + ttl` beside the call would be a second clock that can
 * disagree with the one `jose` read inside `toJwt()` — by a second, at a
 * boundary — and the port promises the token's own expiry, not an estimate.
 * The payload is only decoded here, not verified: this process signed it
 * a line earlier.
 */
function readExpiry(jwt: string): Date {
  const payload = jwt.split('.')[1];
  if (payload === undefined) {
    throw new Error('LiveKit returned a token that is not a JWT');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    exp?: unknown;
  };
  if (typeof claims.exp !== 'number') {
    throw new Error('LiveKit returned a token without an expiry');
  }
  return new Date(claims.exp * 1000);
}
