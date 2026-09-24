/**
 * The call media server, as everything above it sees it (ADR-0034, issue #184).
 *
 * Written as if `infra/calls/` were already a package (ADR-0016, CLAUDE.md §2):
 * **no LiveKit type appears below**, and nothing outside this folder imports
 * `livekit-server-sdk`. Every return type is ours — a room is a name and a
 * time, a participant is an identity and a time, a webhook is one of three
 * events or nothing — so the call state machine in #185 and the reaper in
 * #186 are written against what a call *is*, not against a protobuf. If #183
 * ends at ADR-0034's fallback (c), this file and the call records survive and
 * only the adapter beside it goes.
 */

export const CALL_MEDIA_PROVIDER = Symbol('CALL_MEDIA_PROVIDER');

/**
 * Who may join what. **The caller derives both** — a room name from the call,
 * an identity from the user — because only the caller knows which call was
 * accepted and by whom (ADR-0034 § 3). The port does not invent names and does
 * not check that the call exists; it signs what it is told to sign, which is
 * why #185 may only call it after the accept has been persisted.
 */
export interface JoinTokenRequest {
  readonly roomName: string;
  readonly identity: string;
}

/**
 * Everything a phone needs to join, and nothing it does not.
 *
 * `url` travels with the token rather than being configured on the client
 * because it is the server's decision which media server a call is on, and a
 * URL baked into an app release is one a deploy can no longer move.
 *
 * **`token` is a bearer credential for the room.** It is never logged and
 * never put on `socket.data` — `realtime.types.ts` explains why that object
 * crosses Redis — and it is never minted before a call is accepted.
 */
export interface JoinCredential {
  readonly token: string;
  readonly url: string;
  /** Read back from the minted token itself, not computed beside it. */
  readonly expiresAt: Date;
}

/** A room the media server currently holds open. */
export interface LiveRoom {
  readonly name: string;
  readonly createdAt: Date;
}

/** Someone connected to a room — or, on LiveKit, still connecting. */
export interface RoomParticipant {
  readonly identity: string;
  readonly joinedAt: Date;
}

/**
 * A webhook exactly as it arrived: the **raw** body, before any JSON parsing,
 * and the `Authorization` header or its absence.
 *
 * Raw because the signature is a SHA-256 of the bytes that were sent. A body
 * parsed and re-serialised is a different string — key order, whitespace,
 * number formatting — and would fail verification for a delivery that was
 * perfectly genuine. #186's controller has to hand this over unparsed.
 */
export interface WebhookDelivery {
  readonly body: string;
  readonly authorization: string | undefined;
}

/**
 * The events the calling half acts on, and only those.
 *
 * Each carries the provider's **event id**, because webhooks are delivered at
 * least once and #186 has to be able to recognise the second delivery of one
 * it has already applied; and its **creation time**, because deliveries can
 * arrive out of order and a `participant-left` older than the call's last
 * transition says nothing about the call now.
 */
export type CallMediaEvent =
  | {
      readonly type: 'room-finished';
      readonly eventId: string;
      readonly createdAt: Date;
      readonly roomName: string;
    }
  | {
      readonly type: 'participant-joined' | 'participant-left';
      readonly eventId: string;
      readonly createdAt: Date;
      readonly roomName: string;
      readonly participantIdentity: string;
    };

/**
 * What a webhook turned out to be.
 *
 * **`ignored` is not `invalid`, and #186 must not merge them.** An ignored
 * delivery was signed by the media server and simply names an event this
 * system does not act on — a track being published, a room starting — and the
 * right answer to it is a 2xx, or the server retries it. An invalid one was
 * not provably sent by the server at all, and is discarded rather than trusted
 * with a warning (issue #184): no field of it is returned, so no caller can be
 * tempted to act on "probably fine".
 */
export type WebhookVerification =
  | { readonly status: 'verified'; readonly event: CallMediaEvent }
  | {
      readonly status: 'ignored';
      readonly eventId: string;
      readonly createdAt: Date;
      /** The provider's own name for it, for a log line. Never a branch condition. */
      readonly eventName: string;
    }
  | { readonly status: 'invalid' };

/**
 * The media server could not be asked.
 *
 * **Distinct from an empty answer, on purpose.** The reaper in #186 ends any
 * call whose room is gone; if "could not reach LiveKit" read as "no rooms", a
 * thirty-second network blip would hang up every call in the city. So every
 * operation that talks to the server either answers truthfully or throws this
 * — never a hopeful `[]`.
 *
 * The message names the operation and nothing else. The underlying error is
 * kept as `cause` for a log line, and carries no credential: the SDK signs a
 * per-request token and never puts the secret in an error.
 */
export class CallMediaUnavailableError extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`The call media server could not be reached to ${operation}.`, options);
    this.name = 'CallMediaUnavailableError';
    Object.setPrototypeOf(this, CallMediaUnavailableError.prototype);
  }
}

export interface CallMediaProvider {
  /**
   * Signs a credential that joins `request.roomName` as `request.identity` —
   * that room, that identity, publishing and hearing audio, and nothing else —
   * for a bounded time (`CALL_JOIN_TOKEN_TTL_SECONDS`).
   *
   * Local work: it does not contact the media server, and the room need not
   * exist yet. LiveKit creates a room when its first participant arrives.
   *
   * Throws on an empty room name or identity. Both are programming errors in
   * the caller, and a token scoped to `""` is not a token scoped to anything.
   */
  mintJoinToken(request: JoinTokenRequest): Promise<JoinCredential>;

  /**
   * Closes a room and disconnects everybody in it.
   *
   * **Idempotent**: a room that does not exist — already finished, already
   * deleted by the other party's hangup, or never joined — resolves. Hangup
   * and the reaper will both call this for the same call, and neither should
   * have to know whether the other got there first.
   *
   * @throws {CallMediaUnavailableError} when the server could not be asked.
   */
  deleteRoom(roomName: string): Promise<void>;

  /**
   * Who is in a room right now. A room that does not exist has nobody in it,
   * so it answers `[]` rather than throwing.
   *
   * @throws {CallMediaUnavailableError} when the server could not be asked.
   */
  listParticipants(roomName: string): Promise<readonly RoomParticipant[]>;

  /**
   * Every room the server holds open — not only this system's, if the server
   * is shared, so a caller matches on names it issued.
   *
   * @throws {CallMediaUnavailableError} when the server could not be asked.
   *   Never `[]` for that case; see the error's own docblock.
   */
  listRooms(): Promise<readonly LiveRoom[]>;

  /**
   * Checks that a webhook was sent by the media server and says what it was.
   *
   * **Never throws for a bad delivery** — absent header, wrong signature, a
   * body that does not match its signed hash, a body that is not JSON. Each is
   * `{ status: 'invalid' }`, because a webhook endpoint is public and its
   * input is attacker-chosen; an exception path is one more thing a caller can
   * get wrong.
   */
  verifyWebhook(delivery: WebhookDelivery): Promise<WebhookVerification>;
}
