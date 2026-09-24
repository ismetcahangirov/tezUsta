import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Logger } from '@nestjs/common';

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

/**
 * Thrown when the stub is constructed in production.
 *
 * The mechanism every stub here uses, for the reason they all give: a runtime
 * guard would leave the service booting green and accepting calls, handing
 * both parties a token no media server will ever honour. The first anyone
 * would hear of it is a customer saying the call button does nothing. Refusing
 * to construct turns that into a deploy that stops and names the variable.
 */
export class StubCallMediaProviderInProductionError extends Error {
  constructor() {
    super(
      'CALLS_PROVIDER=stub cannot be used in production: it mints tokens no media server ' +
        'accepts, so every accepted call would connect to nothing. Set CALLS_PROVIDER=livekit ' +
        'with LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET (ADR-0034).',
    );
    this.name = 'StubCallMediaProviderInProductionError';
    Object.setPrototypeOf(this, StubCallMediaProviderInProductionError.prototype);
  }
}

/** Thrown by {@link StubCallMediaProvider.join} for a token the stub would not admit. */
export class StubJoinRefusedError extends Error {
  constructor(reason: string) {
    super(`The stub media server refused the join: ${reason}`);
    this.name = 'StubJoinRefusedError';
    Object.setPrototypeOf(this, StubJoinRefusedError.prototype);
  }
}

interface StubRoom {
  readonly createdAt: Date;
  readonly participants: Map<string, Date>;
}

interface StubTokenClaims {
  readonly room: string;
  readonly identity: string;
  /** Seconds since the epoch, like a JWT's `exp`. */
  readonly exp: number;
}

const TOKEN_PREFIX = 'stub';
const WEBHOOK_SCHEME = 'Stub';

/**
 * The development and test media server: an in-memory room registry that
 * behaves like one.
 *
 * Not a recorder of calls. It **signs** its tokens and **checks** them on
 * {@link join}, so a token for room A puts its holder in room A and nowhere
 * else, and an expired one is refused. That is what lets the same contract
 * suite run against it and against a real LiveKit (`test/support/
 * call-media-contract.ts`): a stub that accepted any string would make #185's
 * tests pass for a state machine that hands out the wrong token.
 *
 * What it deliberately does not prove is that LiveKit accepts what the adapter
 * mints — only the LiveKit suite can, against the server in `docker compose`.
 */
export class StubCallMediaProvider implements CallMediaProvider {
  private readonly logger = new Logger(StubCallMediaProvider.name);

  /**
   * Per instance, so a token or webhook signed by one stub is a forgery to
   * another — which is how the contract suite proves a foreign signature is
   * refused without a second implementation of HMAC in the test.
   */
  private readonly key = randomBytes(32);

  private readonly rooms = new Map<string, StubRoom>();

  /**
   * Set to make every operation that would talk to a server fail, the way an
   * unreachable LiveKit does — so #186 can prove its reaper tells "could not
   * ask" from "no rooms" without stopping a container.
   */
  failWith: Error | undefined;

  constructor(
    private readonly nodeEnv: 'development' | 'test' | 'production',
    private readonly joinTokenTtlSeconds: number,
  ) {
    if (nodeEnv === 'production') {
      throw new StubCallMediaProviderInProductionError();
    }
  }

  mintJoinToken(request: JoinTokenRequest): Promise<JoinCredential> {
    const invalid =
      nameError('roomName', request.roomName) ?? nameError('identity', request.identity);
    if (invalid !== undefined) {
      return Promise.reject(invalid);
    }

    const exp = Math.floor(Date.now() / 1000) + this.joinTokenTtlSeconds;
    const claims: StubTokenClaims = { room: request.roomName, identity: request.identity, exp };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${TOKEN_PREFIX}.${payload}.${this.sign(payload)}`;

    if (this.nodeEnv === 'development') {
      // The room and the identity, never the token — it is a bearer
      // credential even when it is a stub's, and a log that shows one trains
      // everyone to expect tokens in logs.
      this.logger.warn(
        `[STUB CALLS] join token minted for ${request.identity} in ${request.roomName}`,
      );
    }

    return Promise.resolve({ token, url: 'stub://calls', expiresAt: new Date(exp * 1000) });
  }

  /**
   * Joins the room the token names, as the identity it names — what a phone
   * does when it connects. Test-facing: nothing in the application calls it.
   *
   * @throws {StubJoinRefusedError} for a token this instance did not sign, or
   *   one that has expired.
   */
  join(token: string): { leave(): void } {
    const claims = this.verifyToken(token);

    const room = this.rooms.get(claims.room) ?? { createdAt: new Date(), participants: new Map() };
    this.rooms.set(claims.room, room);
    room.participants.set(claims.identity, new Date());

    return {
      leave: () => {
        room.participants.delete(claims.identity);
      },
    };
  }

  deleteRoom(roomName: string): Promise<void> {
    const invalid = nameError('roomName', roomName);
    if (invalid !== undefined) {
      return Promise.reject(invalid);
    }
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    this.rooms.delete(roomName);
    return Promise.resolve();
  }

  listParticipants(roomName: string): Promise<readonly RoomParticipant[]> {
    const invalid = nameError('roomName', roomName);
    if (invalid !== undefined) {
      return Promise.reject(invalid);
    }
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    const room = this.rooms.get(roomName);
    return Promise.resolve(
      room === undefined
        ? []
        : [...room.participants].map(([identity, joinedAt]) => ({ identity, joinedAt })),
    );
  }

  listRooms(): Promise<readonly LiveRoom[]> {
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve(
      [...this.rooms].map(([name, room]) => ({ name, createdAt: room.createdAt })),
    );
  }

  /**
   * Signs a webhook body the way this instance will verify it. Test-facing:
   * the stub's wire format is the JSON of a {@link CallMediaEvent} (or of any
   * object with a `type`, `eventId` and `createdAt`), since there is no real
   * server whose format it would have to mimic.
   */
  signWebhook(body: string): string {
    return `${WEBHOOK_SCHEME} ${this.sign(body)}`;
  }

  verifyWebhook(delivery: WebhookDelivery): Promise<WebhookVerification> {
    const expected = this.signWebhook(delivery.body);
    if (delivery.authorization === undefined || !safeEqual(delivery.authorization, expected)) {
      return Promise.resolve({ status: 'invalid' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(delivery.body);
    } catch {
      return Promise.resolve({ status: 'invalid' });
    }
    return Promise.resolve(toVerification(parsed));
  }

  /** Forget every room, so one suite's calls do not leak into the next. */
  reset(): void {
    this.rooms.clear();
    this.failWith = undefined;
  }

  private verifyToken(token: string): StubTokenClaims {
    const [prefix, payload, signature] = token.split('.');
    if (prefix !== TOKEN_PREFIX || payload === undefined || signature === undefined) {
      throw new StubJoinRefusedError('not a stub token');
    }
    if (!safeEqual(signature, this.sign(payload))) {
      throw new StubJoinRefusedError('the signature does not verify');
    }
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as StubTokenClaims;
    if (claims.exp * 1000 <= Date.now()) {
      throw new StubJoinRefusedError('the token has expired');
    }
    return claims;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}

function toVerification(parsed: unknown): WebhookVerification {
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'invalid' };
  }
  const record = parsed as Record<string, unknown>;
  const { type, eventId, createdAt, roomName, participantIdentity } = record;
  if (typeof type !== 'string' || typeof eventId !== 'string' || typeof createdAt !== 'string') {
    return { status: 'invalid' };
  }
  const created = new Date(createdAt);

  if (type === 'room-finished' && typeof roomName === 'string') {
    return { status: 'verified', event: { type, eventId, createdAt: created, roomName } };
  }
  if (
    (type === 'participant-joined' || type === 'participant-left') &&
    typeof roomName === 'string' &&
    typeof participantIdentity === 'string'
  ) {
    const event: CallMediaEvent = {
      type,
      eventId,
      createdAt: created,
      roomName,
      participantIdentity,
    };
    return { status: 'verified', event };
  }
  return { status: 'ignored', eventId, createdAt: created, eventName: type };
}

/**
 * Returned rather than thrown, so every method can reject with it: the
 * LiveKit adapter's methods are `async` and reject, and the contract suite
 * holds both implementations to one behaviour.
 */
function nameError(field: string, value: string): TypeError | undefined {
  return value.length === 0 ? new TypeError(`${field} must not be empty`) : undefined;
}

/** Constant-time, and false rather than a throw for strings of different lengths. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
