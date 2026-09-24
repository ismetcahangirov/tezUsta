/**
 * An in-app voice call between the two parties to one order, as both apps read
 * it (issue #185, [ADR-0034](docs/decisions/ADR-0034-in-app-voice-calls.md)).
 *
 * **A call is a property of an order, the way a conversation is** (ADR-0033
 * § 2, ADR-0034 § 6): it can be placed only while the order's conversation is
 * open, and it ends when the order stops being live. Nothing below names a
 * phone number — the whole point of the feature is that neither party ever
 * learns the other's.
 *
 * Literal unions rather than values, for the reason every file in this package
 * gives: it ships TypeScript source with no build step, which holds only while
 * every export is a type. The server writes each literal once in its own
 * constants and lets these unions refuse a typo.
 */

/**
 * Where a call is in its life. The legal edges between them live in one place,
 * `apps/api/src/modules/calls/call-lifecycle.ts`, the way the order's live in
 * `order-lifecycle.ts`.
 *
 * - `RINGING` — invited, the callee's device is ringing.
 * - `ACCEPTED` — the callee answered; both parties may join the media room.
 * - `REJECTED` — the callee declined.
 * - `CANCELLED` — the caller gave up before it was answered.
 * - `TIMED_OUT` — nobody answered within the ring timeout. Decided by the
 *   server, never by a client timer, so a caller whose app was killed
 *   mid-ring still leaves a finished call behind.
 * - `BUSY` — refused at the invite because one of the two parties was already
 *   on a live call. **Terminal at creation**: the row exists so the refused
 *   attempt is on the record, and it never rang.
 * - `ENDED` — a call that is over for any other reason; see {@link CallEndReason}.
 *
 * `RINGING` and `ACCEPTED` are the two **live** statuses; every other one is
 * terminal and nothing moves a call out of it.
 */
export type CallStatus =
  'RINGING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'TIMED_OUT' | 'BUSY' | 'ENDED';

/**
 * Why a call finished. Null while it is live.
 *
 * A closed set, and the server's own words. The mobile call screen (#187)
 * translates them into its own vocabulary — `hangup` is its "completed",
 * `room_gone` and `reaped` are its "dropped" — rather than the server learning
 * what a screen says.
 *
 * - `declined` — `REJECTED`: the callee said no.
 * - `cancelled` — `CANCELLED`: the caller hung up while it rang.
 * - `no_answer` — `TIMED_OUT`.
 * - `busy` — `BUSY`.
 * - `hangup` — `ENDED`: one party hung up an answered call.
 * - `order_closed` — `ENDED`: the order stopped being live (completed,
 *   cancelled, re-dispatched, or any other move out of the statuses in which
 *   its conversation is open), and took the call with it.
 * - `room_gone` — `ENDED`: the media server reports the room finished (#186).
 * - `reaped` — `ENDED`: the server's sweep found a call nobody was in (#186).
 */
export type CallEndReason =
  | 'declined'
  | 'cancelled'
  | 'no_answer'
  | 'busy'
  | 'hangup'
  | 'order_closed'
  | 'room_gone'
  | 'reaped';

/** Which side of the order a party to a call is on. */
export type CallPartyKind = 'customer' | 'master';

/**
 * One call, **as one of its two parties sees it**.
 *
 * Presented per viewer, which is why it has `role` and `peer` rather than a
 * caller and a callee: the ringing screen on one phone and the calling screen
 * on the other are rendered from the same row, and each needs to know which
 * one it is and who is on the other end. Neither party's account id appears.
 */
export interface Call {
  readonly id: string;
  readonly orderId: string;
  readonly status: CallStatus;
  readonly endReason: CallEndReason | null;
  /** Whether the viewer placed this call or is receiving it. */
  readonly role: 'caller' | 'callee';
  /**
   * The other party: which side of the order they are on, and the name their
   * profile carries — the same name the order surface already shows. Null
   * only if that profile has since been deleted.
   */
  readonly peer: {
    readonly kind: CallPartyKind;
    readonly displayName: string | null;
  };
  /** ISO 8601. When the invite was recorded. */
  readonly startedAt: string;
  /** ISO 8601, or null for a call nobody answered. */
  readonly answeredAt: string | null;
  /** ISO 8601, or null while the call is live. */
  readonly endedAt: string | null;
}

/**
 * Everything a phone needs to join an accepted call's media room.
 *
 * **Handed only to the device that is actually in the call**, and only once
 * the call is `ACCEPTED` (ADR-0034 § 3): to the callee in the ack of its own
 * `call:accept`, and to the caller — or to either party reconnecting — from
 * `POST /calls/:id/join`. It is never in a broadcast frame, never in a push,
 * and never logged. `token` is a bearer credential for the room.
 */
export interface CallJoinCredential {
  readonly callId: string;
  /** Short-lived; the server's `CALL_JOIN_TOKEN_TTL_SECONDS`. */
  readonly token: string;
  /** The media server to dial. The server's choice, so a deploy can move it. */
  readonly url: string;
  /** ISO 8601, read back from the token itself. */
  readonly expiresAt: string;
  /** The identity this credential joins the room as. */
  readonly identity: string;
  /**
   * The identity the other party joins as, so the app can recognise the peer
   * leaving the room — one of the three end-of-call signals ADR-0034 § 4
   * requires it to act on.
   */
  readonly peerIdentity: string;
}

/** Outbound: what the server tells both parties' devices about a call. */
export type CallRealtimeEventName =
  | 'call:incoming'
  | 'call:accepted'
  | 'call:rejected'
  | 'call:cancelled'
  | 'call:timeout'
  | 'call:busy'
  | 'call:ended';

/** Inbound: what a device may ask the server to do with a call. */
export type CallRequestName =
  'call:invite' | 'call:accept' | 'call:reject' | 'call:cancel' | 'call:hangup';

/**
 * Every outbound call frame has this one shape: the call as the recipient sees
 * it, and when the server published it (epoch milliseconds, the publishing
 * instance's clock — the same rule as `RealtimeEvent.at`).
 *
 * **One shape for seven names** because the frame's name is the fact and the
 * call is the state; a client reducer switches on the name and reads the
 * status, and ignores a frame that does not apply to its current phase, so a
 * late or duplicated one is harmless (ADR-0034 § 4).
 *
 * `call:incoming` goes to the callee only and `call:busy` to the caller only;
 * every other frame goes to both parties' devices — all of them, so the
 * callee's second phone stops ringing when the first one answers.
 */
export interface CallRealtimeEvent {
  readonly call: Call;
  readonly at: number;
}

/**
 * `call:invite`. **Only the order**: the callee is whoever the other party to
 * that order is, derived by the server. A client that could name the callee
 * could ring anybody.
 */
export interface CallInviteRequest {
  readonly orderId: string;
}

/** `call:accept`, `call:reject`, `call:cancel` and `call:hangup`. */
export interface CallActionRequest {
  readonly callId: string;
}

/**
 * Why a call frame was refused — the socket's equivalent of the HTTP error
 * envelope's `code`.
 *
 * - `CALL_INVALID` — the payload was not the frame's shape.
 * - `CALL_FORBIDDEN` — not your order, not your call, no such call, or the
 *   order is not in a state to call about. **Deliberately indistinguishable**,
 *   so the socket cannot be used to learn which order or call ids exist.
 * - `CALL_STALE` — your call, but it has already moved on: accepting a call
 *   the caller already cancelled, hanging up one that already ended. The
 *   refusal carries the call as it now is.
 * - `CALL_RATE_LIMITED` — too many invites from this account on this order.
 * - `CALL_UNAVAILABLE` — the server could not complete the frame just now.
 *   On an accept that carries the call, the call **is** accepted and only
 *   the credential is missing: fetch it from `POST /calls/:id/join`.
 * - `RATE_LIMITED` — this connection sent more frames than its budget allows.
 */
export type CallErrorCode =
  | 'CALL_INVALID'
  | 'CALL_FORBIDDEN'
  | 'CALL_STALE'
  | 'CALL_RATE_LIMITED'
  | 'CALL_UNAVAILABLE'
  | 'RATE_LIMITED';

export interface CallRefusal {
  readonly ok: false;
  readonly code: CallErrorCode;
  readonly message: string;
  /** Present with `CALL_STALE` only: the call as it actually is. */
  readonly call?: Call;
}

/**
 * The ack of `call:invite`: the call as recorded. **`status` may be `BUSY`**
 * — the invite was valid and was refused because somebody is already on a
 * call, which is an outcome rather than an error, and the row exists.
 */
export type CallInviteAck = { readonly ok: true; readonly call: Call } | CallRefusal;

/**
 * The ack of `call:accept`: the accepted call, and this device's credential
 * for the room. The only frame that ever carries one.
 */
export type CallAcceptAck =
  { readonly ok: true; readonly call: Call; readonly credential: CallJoinCredential } | CallRefusal;

/** The ack of `call:reject`, `call:cancel` and `call:hangup`. */
export type CallActionAck = { readonly ok: true; readonly call: Call } | CallRefusal;

/**
 * One call in an order's history, as one of its two parties reads it
 * (`GET /orders/:orderId/calls`, issue #186).
 *
 * The same presentation as {@link Call} — `role` **is** the direction: a
 * `caller` row is one the viewer placed, a `callee` row one they received — plus
 * how long it lasted. No second "direction" field, because two fields saying
 * one thing are two fields a client can one day see disagree.
 *
 * **Who, when, how long and the outcome. Never the contents** — nothing is
 * recorded (ADR-0034 § 2) — and never a phone number or a room credential.
 */
export interface CallRecord extends Call {
  /**
   * Whole seconds from `answeredAt` to `endedAt`, computed by the server from
   * its own timestamps and never from anything a client reported. Null for a
   * call nobody answered, and while an answered call is still live — a
   * number that grows while it is read is not a record.
   */
  readonly durationSeconds: number | null;
}

/** One side of a call as an admin reads it: which side, which profile, what name. */
export interface AdminCallParty {
  readonly kind: CallPartyKind;
  /** The customer id or the master id. Never the account id, never the phone. */
  readonly profileId: string;
  /** Null only if the profile has since been deleted. */
  readonly displayName: string | null;
}

/**
 * One call as the admin surface lists it (`GET /admin/calls`, issue #186).
 *
 * Caller and callee rather than `role` and `peer`: an admin is neither party.
 * PII-adjacent by nature — who rang whom about which job, and when — so it
 * carries **no phone number, no account id and no room token**, which the
 * issue's acceptance criteria and its e2e test both hold it to.
 */
export interface AdminCallRecord {
  readonly id: string;
  readonly orderId: string;
  readonly caller: AdminCallParty;
  readonly callee: AdminCallParty;
  readonly status: CallStatus;
  readonly endReason: CallEndReason | null;
  /** ISO 8601. */
  readonly startedAt: string;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  /** As on {@link CallRecord}. */
  readonly durationSeconds: number | null;
}
