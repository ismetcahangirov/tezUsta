import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type {
  Call,
  CallAcceptAck,
  CallActionAck,
  CallEndReason,
  CallErrorCode,
  CallInviteAck,
  CallJoinCredential,
  CallPartyKind,
  CallRealtimeEventName,
  CallRefusal,
  CallStatus,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { CALL_MEDIA_PROVIDER } from '../../infra/calls/call-media.types';
import type { CallMediaProvider } from '../../infra/calls/call-media.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { isUniqueViolationOn } from '../../infra/database/database-error';
import type { CallRow } from '../../infra/database/schema/calls';
import type { OrderRow } from '../../infra/database/schema/orders';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { DeferredWorkService } from '../../infra/queue/deferred-work.service';
import { RateLimiterService } from '../../infra/rate-limit/rate-limiter.service';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import {
  ConversationsService,
  isWritable,
  isWritableStatus,
} from '../orders/conversations.service';
import { OrderNotificationsRegistry } from '../orders/order-notifications.registry';
import type { OrderTransitionEvent } from '../orders/order-notifications.registry';
import { checkCallTransition } from './call-lifecycle';
import type { CallEdgeActor } from './call-lifecycle';
import {
  CALL_ACCEPTED_EVENT,
  CALL_BUSY_EVENT,
  CALL_CANCELLED_EVENT,
  CALL_ENDED_EVENT,
  CALL_INCOMING_EVENT,
  CALL_REJECTED_EVENT,
  CALL_TIMEOUT_EVENT,
} from './call.events';
import { CallEventsRegistry } from './call-events.registry';
import type { CallDelivery } from './call-events.registry';
import { callRoomName, CallsRepository } from './calls.repository';
import type { CallParty } from './calls.repository';
import { callRingTimeoutPayloadSchema } from './calls.schema';
import type { CallActionInput, CallInviteInput } from './calls.schema';

/** A party to a call: the two edge actors that are people. */
type CallSide = Exclude<CallEdgeActor, 'system'>;

/** The deferred job that ends a call nobody answered. */
export const CALL_RING_TIMEOUT_JOB = 'call-ring-timeout';

/**
 * One timeout per call. Hyphens, not colons, for the reason
 * `dispatch.constants.ts` gives: BullMQ builds Redis keys with `:`.
 */
export function callRingTimeoutJobId(callId: string): string {
  return `call-ring-timeout-${callId}`;
}

/** The rate-limit scope for invites. Part of the Redis key; never a person. */
const INVITE_RATE_LIMIT_SCOPE = 'call-invite';

/**
 * The one sentence a device is shown for each refusal. No ids, no order
 * status — the code is what a client branches on.
 */
const CALL_REFUSAL_MESSAGES: Readonly<Record<CallErrorCode, string>> = Object.freeze({
  CALL_INVALID: 'That is not a call request.',
  CALL_FORBIDDEN: 'You cannot do that with this call.',
  CALL_STALE: 'This call has already moved on.',
  CALL_RATE_LIMITED: 'Too many calls on this order. Try again later.',
  CALL_UNAVAILABLE: 'The call could not be completed right now.',
  RATE_LIMITED: 'Too many messages.',
});

export function callRefusal(code: CallErrorCode, call?: Call): CallRefusal {
  return call === undefined
    ? { ok: false, code, message: CALL_REFUSAL_MESSAGES[code] }
    : { ok: false, code, message: CALL_REFUSAL_MESSAGES[code], call };
}

/**
 * `POST /calls/:id/join` on a call that is yours but has no room to join.
 * See `ERROR_CODES.CALL_NOT_JOINABLE`.
 */
export class CallNotJoinableError extends AppError {
  constructor(status: CallStatus) {
    super(
      ERROR_CODES.CALL_NOT_JOINABLE,
      'This call is not in progress, so there is no room to join.',
      409,
      // The caller's own call's status — nothing they could not already read.
      { callStatus: status },
    );
    this.name = 'CallNotJoinableError';
    Object.setPrototypeOf(this, CallNotJoinableError.prototype);
  }
}

/** The two parties to an order, as a call between them needs them. */
interface CallableOrder {
  readonly order: OrderRow;
  readonly caller: CallParty;
  readonly callee: CallParty;
}

/**
 * The ring/answer state machine (issue #185, ADR-0034 § 3, § 4, § 6).
 *
 * **Every decision here is taken against current state.** The actor arrives
 * re-resolved from the database by the frame handler (`ActorService.current`),
 * the order and whether this actor is a party to it are re-read through the
 * conversation's own party rule, and the call row is re-read before every
 * transition — which is then written as a conditional `UPDATE` on the status
 * that was read, so a race is lost cleanly rather than won twice.
 *
 * **A call is possible exactly when the order's conversation is open and
 * writable** — `ConversationsService.requireParty` plus `isWritable`, not a
 * second list. ADR-0034 § 6 binds a call to the order with ADR-0033 § 2's
 * rule, and one implementation is what keeps chat and calling opening and
 * closing together: the master a re-dispatch removed loses both at once.
 *
 * **A credential is minted on one path only**: an accept that has committed,
 * for the device that sent it — or `POST /calls/:id/join` on a call that is
 * `ACCEPTED` (ADR-0034 § 3). Nothing here puts a token in a frame, in a push
 * or in a log; the frames carry the call and nothing else.
 *
 * **Failures refuse; they do not throw**, for every socket method: a refusal
 * belongs in the ack of the frame that caused it (`room.types.ts`). Only the
 * HTTP join throws, because that is how an HTTP handler refuses.
 */
@Injectable()
export class CallsService implements OnModuleInit {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly calls: CallsRepository,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    @Inject(CALL_MEDIA_PROVIDER) private readonly media: CallMediaProvider,
    private readonly deferredWork: DeferredWorkService,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly orderEvents: OrderNotificationsRegistry,
    private readonly events: CallEventsRegistry,
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Two subscriptions, both slots other modules own, so neither of them
   * imports this one:
   *
   * - the ring timeout, on the deferred-work queue (ADR-0025);
   * - every committed order transition, so an order that stops being live
   *   ends its call (ADR-0034 § 6). `OrderNotificationsRegistry` is the seam
   *   the socket and the push already hang off, it isolates each subscriber's
   *   failure from the others', and it is raised after the commit — so the
   *   order has really moved when a call is ended for it.
   */
  onModuleInit(): void {
    this.handlers.register(CALL_RING_TIMEOUT_JOB, (payload) => this.timeOut(payload));
    this.orderEvents.register(
      'calls',
      (event) => this.onOrderTransition(event),
      () => Promise.resolve(),
    );
  }

  /**
   * Rings the other party to an order.
   *
   * **The client names the order and nothing else.** The callee is whoever
   * the other party to that order is *now*, derived here; the caller is the
   * actor. A refusal for any reason — not your order, no such order, an order
   * that is not live — is the same `CALL_FORBIDDEN`, so the socket is not an
   * oracle for which order ids exist.
   *
   * Then the rate limit, which counts every authorized attempt — including
   * one that meets a busy line — and only then the atomic busy decision.
   */
  async invite(actor: Actor, input: CallInviteInput): Promise<CallInviteAck> {
    const callable = await this.resolveCallable(actor, input.orderId);

    if (callable === undefined) {
      return callRefusal('CALL_FORBIDDEN');
    }

    const { signalling } = this.config.calls;
    const windowMs = signalling.inviteWindowSeconds * 1000;
    const decision = await this.limiter.consume({
      scope: INVITE_RATE_LIMIT_SCOPE,
      dimension: 'identifier',
      // Per account *and* per order: the budget bounds one person ringing the
      // other party to one job. Hashed before it reaches Redis.
      subject: `${actor.userId}:${input.orderId}`,
      limit: signalling.invitesPerOrder,
      windowMs,
      backoffCeilingMs: windowMs,
    });

    if (!decision.allowed) {
      this.logger.warn(`call invites rate-limited for subject ${decision.subjectDigest}`);
      return callRefusal('CALL_RATE_LIMITED');
    }

    const outcome = await this.createUnlessBusy(input.orderId, callable);

    if (outcome.kind === 'order-closed') {
      // The order stopped being callable between the check above and the
      // insert — the insert's own re-read under `FOR SHARE` caught it.
      return callRefusal('CALL_FORBIDDEN');
    }

    // **The deadline first, before anything that can fail.** From the commit
    // on, the call exists; every step below is a consequence of that, and a
    // failure in one of them must not cost the call its timeout — a ringing
    // row with no deadline holds both parties busy until somebody acts.
    if (outcome.kind === 'ringing') {
      await this.scheduleTimeout(outcome.call.id);
    }

    const names = await this.namesFor(outcome.call);

    if (outcome.kind === 'busy') {
      // To the caller only, and to every device they hold. The callee is on
      // another call and is not disturbed by one they never saw ring.
      await this.events.publish([this.delivery(CALL_BUSY_EVENT, outcome.call, 'caller', names)]);
      return { ok: true, call: present(outcome.call, 'caller', names) };
    }

    await this.events.publish([this.delivery(CALL_INCOMING_EVENT, outcome.call, 'callee', names)]);
    return { ok: true, call: present(outcome.call, 'caller', names) };
  }

  /**
   * The callee answers — and **this is the one socket path that mints a
   * credential**, for the device that sent the frame and returned in its ack.
   *
   * The order is re-checked as well as the call. A call can outlive its
   * order's liveness by the width of a race — the order closed and its
   * subscriber has not ended the call yet — and a credential issued into that
   * window would be a room the order no longer entitles anyone to.
   *
   * `call:accepted` goes to both parties' devices **without** a credential:
   * the callee's other phones stop ringing, and the caller fetches its own
   * credential from `POST /calls/:id/join`. A broadcast frame is heard by
   * every device an account holds, which is exactly why it cannot carry one.
   */
  async accept(actor: Actor, input: CallActionInput): Promise<CallAcceptAck> {
    const found = await this.loadOwnCall(actor, input.callId);
    if (found === undefined) {
      return callRefusal('CALL_FORBIDDEN');
    }

    const refused = await this.refuseEdge(found.call, found.role, 'ACCEPTED');
    if (refused !== undefined) {
      return refused;
    }

    const callable = await this.resolveCallable(actor, found.call.orderId);
    if (callable === undefined || !sameParties(callable, found.call)) {
      return callRefusal('CALL_FORBIDDEN');
    }

    const accepted = await this.calls.transition({
      callId: found.call.id,
      from: 'RINGING',
      to: 'ACCEPTED',
    });
    if (accepted === undefined) {
      return this.stale(found.call.id, found.role);
    }

    const names = await this.namesFor(accepted);
    await this.events.publish(this.toBoth(CALL_ACCEPTED_EVENT, accepted, names));

    const call = present(accepted, found.role, names);
    let credential: CallJoinCredential;
    try {
      credential = await this.credentialFor(accepted, found.role);
    } catch (error) {
      // The call is accepted and stays so; the device fetches its credential
      // from `POST /calls/:id/join`. The error is the provider's own, which
      // never carries a token or a secret (`call-media.types.ts`).
      this.logger.error(
        `minting a join credential for accepted call ${accepted.id} failed: ${describe(error)}`,
      );
      return callRefusal('CALL_UNAVAILABLE', call);
    }

    // **Handed out only if the call is still answered now that it is signed.**
    // The order closing can end the call between the transition above and the
    // mint; a token for an ended call's room would let its holder recreate an
    // empty room that nothing but #186's reaper would close. Dropping the
    // unsent token costs nothing — minting is local signing — and the device
    // is told the call as it now is.
    const still = await this.calls.findById(accepted.id);
    if (still?.status !== 'ACCEPTED') {
      return still === undefined
        ? callRefusal('CALL_FORBIDDEN')
        : callRefusal('CALL_STALE', present(still, found.role, await this.namesFor(still)));
    }

    return { ok: true, call, credential };
  }

  /** The callee declines. */
  async reject(actor: Actor, input: CallActionInput): Promise<CallActionAck> {
    return this.finish(actor, input.callId, 'REJECTED', 'declined', CALL_REJECTED_EVENT);
  }

  /** The caller gives up before an answer. */
  async cancel(actor: Actor, input: CallActionInput): Promise<CallActionAck> {
    return this.finish(actor, input.callId, 'CANCELLED', 'cancelled', CALL_CANCELLED_EVENT);
  }

  /**
   * Either party ends an answered call — and the media room is closed, **best
   * effort**. The call is `ENDED` the moment the `UPDATE` commits; a media
   * server that cannot be reached must not undo that, and #186's reaper
   * closes rooms whose call is over.
   */
  async hangup(actor: Actor, input: CallActionInput): Promise<CallActionAck> {
    const ack = await this.finish(actor, input.callId, 'ENDED', 'hangup', CALL_ENDED_EVENT);
    if (ack.ok) {
      await this.closeRoom(input.callId);
    }
    return ack;
  }

  /**
   * A credential for the device asking, on a call it is a party to that is
   * `ACCEPTED` and whose order is still live — the caller after an answer,
   * or either party reconnecting. **The only other place a token is minted.**
   *
   * 404 for a stranger and for an unknown id alike; 409 for a party whose call
   * has no room to join.
   */
  async join(actor: Actor, callId: string): Promise<CallJoinCredential> {
    const found = await this.loadOwnCall(actor, callId);
    if (found === undefined) {
      throw new NotFoundError();
    }

    if (found.call.status !== 'ACCEPTED') {
      throw new CallNotJoinableError(found.call.status);
    }

    const callable = await this.resolveCallable(actor, found.call.orderId);
    if (callable === undefined || !sameParties(callable, found.call)) {
      throw new CallNotJoinableError(found.call.status);
    }

    const credential = await this.credentialFor(found.call, found.role);

    // The same re-read as `accept`, for the same race: the order-close hook
    // can end the call between the read above and the mint.
    const still = await this.calls.findById(callId);
    if (still?.status !== 'ACCEPTED') {
      throw new CallNotJoinableError(still?.status ?? found.call.status);
    }

    return credential;
  }

  /**
   * The ring timeout. **Idempotent and race-safe by construction**: a
   * conditional `RINGING → TIMED_OUT` that matches nothing because the call
   * was answered, declined or cancelled first is simply a job with nothing
   * left to do. That is also why the job is never cancelled when a call is
   * resolved early — cancelling would be one more Redis round trip on every
   * answer, to save one primary-key `UPDATE` that matches no row.
   *
   * It needs no socket from anybody, which is the requirement: a caller whose
   * app was killed mid-ring still leaves a finished call behind.
   */
  async timeOut(payload: Record<string, unknown>): Promise<void> {
    const { callId } = callRingTimeoutPayloadSchema.parse(payload);

    const timedOut = await this.calls.transition({
      callId,
      from: 'RINGING',
      to: 'TIMED_OUT',
      endReason: 'no_answer',
    });

    if (timedOut === undefined) {
      return;
    }

    const names = await this.namesFor(timedOut);
    await this.events.publish(this.toBoth(CALL_TIMEOUT_EVENT, timedOut, names));
  }

  /**
   * An order transition committed. If the order is no longer one its parties
   * may call about — completed, cancelled, re-dispatched, disputed, or any
   * other status in which its conversation is not writable — its live call
   * ends, ringing or answered.
   *
   * Asked of the status the transaction **landed on**, never the one asked
   * for, which is what the event carries. Most transitions find no live call;
   * the `UPDATE` is on `calls_one_live_per_order`, so that costs one index
   * probe.
   */
  private async onOrderTransition(event: OrderTransitionEvent): Promise<void> {
    if (isWritableStatus(event.to)) {
      return;
    }

    const ended = await this.calls.endLiveForOrder(event.orderId, 'order_closed');

    for (const { call, wasAnswered } of ended) {
      const names = await this.namesFor(call);
      await this.events.publish(this.toBoth(CALL_ENDED_EVENT, call, names));
      if (wasAnswered) {
        await this.closeRoom(call.id);
      }
    }
  }

  /**
   * A party moves a call to a terminal status: the shared body of reject,
   * cancel and hangup, which differ only in the edge, its reason and the
   * frame. Who may take which edge is `call-lifecycle.ts`'s answer.
   */
  private async finish(
    actor: Actor,
    callId: string,
    to: CallStatus,
    reason: CallEndReason,
    event: CallRealtimeEventName,
  ): Promise<CallActionAck> {
    const found = await this.loadOwnCall(actor, callId);
    if (found === undefined) {
      return callRefusal('CALL_FORBIDDEN');
    }

    const refused = await this.refuseEdge(found.call, found.role, to);
    if (refused !== undefined) {
      return refused;
    }

    const moved = await this.calls.transition({
      callId,
      from: found.call.status,
      to,
      endReason: reason,
    });
    if (moved === undefined) {
      return this.stale(callId, found.role);
    }

    const names = await this.namesFor(moved);
    await this.events.publish(this.toBoth(event, moved, names));
    return { ok: true, call: present(moved, found.role, names) };
  }

  /**
   * The call, and which side of it this actor is on — or `undefined` for a
   * call that does not exist or that this account is not on. One answer for
   * both, so a call id is not something the socket confirms the existence of.
   *
   * By **account**, because that is what the row's party columns were
   * written from and what busy is decided on; whether the account is still a
   * party to the *order* is the separate question {@link resolveCallable}
   * answers where it matters.
   */
  private async loadOwnCall(
    actor: Actor,
    callId: string,
  ): Promise<{ call: CallRow; role: CallSide } | undefined> {
    const call = await this.calls.findById(callId);

    if (call === undefined) {
      return undefined;
    }
    if (call.calleeUserId === actor.userId) {
      return { call, role: 'callee' };
    }
    if (call.callerUserId === actor.userId) {
      return { call, role: 'caller' };
    }
    return undefined;
  }

  /**
   * Why this party may not take this edge right now, or `undefined`.
   *
   * An edge that does not exist from where the call *is* — accepting a call
   * already cancelled, hanging up one already over — is `CALL_STALE`, with
   * the call as it is so the device can settle on the truth. An edge that
   * exists but is the other party's — the caller "accepting" their own call —
   * is `CALL_FORBIDDEN`.
   */
  private async refuseEdge(
    call: CallRow,
    role: CallSide,
    to: CallStatus,
  ): Promise<CallRefusal | undefined> {
    switch (checkCallTransition(call.status, to, role)) {
      case 'allowed':
        return undefined;
      case 'not-permitted':
        return callRefusal('CALL_FORBIDDEN');
      case 'invalid-edge':
        return callRefusal('CALL_STALE', present(call, role, await this.namesFor(call)));
    }
  }

  /** A conditional write lost its race: report the call as it now is. */
  private async stale(callId: string, role: CallSide): Promise<CallRefusal> {
    const current = await this.calls.findById(callId);
    return current === undefined
      ? callRefusal('CALL_FORBIDDEN')
      : callRefusal('CALL_STALE', present(current, role, await this.namesFor(current)));
  }

  /**
   * Whether this actor may call about this order now, and who with — or
   * `undefined`.
   *
   * **The conversation's party rule, not a copy of it**: an open conversation
   * on a writable order, and the actor on one side of it. The master side is
   * the conversation's `master_id`, which in a writable status is the order's
   * assigned master; the customer side is the order's customer. Both are
   * turned into their accounts, because that is what busy is decided on and
   * what the frames are delivered to.
   */
  private async resolveCallable(actor: Actor, orderId: string): Promise<CallableOrder | undefined> {
    let party: Awaited<ReturnType<ConversationsService['requireParty']>>;
    try {
      party = await this.conversations.requireParty(actor, orderId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }

    const { order, conversation, side } = party;
    if (!isWritable(order)) {
      return undefined;
    }

    const customer = { kind: 'customer' as const, id: order.customerId };
    const master = { kind: 'master' as const, id: conversation.masterId };
    const other = side === 'customer' ? master : customer;
    const otherUserId =
      other.kind === 'customer'
        ? await this.customers.findUserId(other.id)
        : (await this.masters.findUserIds([other.id])).get(other.id);

    // A profile deleted under a live order, or — impossible through the
    // accept path, refused here anyway — one account on both sides of its own
    // order. Neither is somebody to ring.
    if (otherUserId === undefined || otherUserId === actor.userId) {
      return undefined;
    }

    const self = side === 'customer' ? customer : master;
    return {
      order,
      caller: { ...self, userId: actor.userId },
      callee: { ...other, userId: otherUserId },
    };
  }

  /**
   * The repository's atomic busy decision, with the partial unique index
   * turned from a 500 into the answer it stands for.
   *
   * The advisory locks make a `calls_one_live_per_order` violation unreachable
   * through this path. If one arrives anyway — a writer elsewhere that took no
   * lock — it means a live call on this order committed first, so the honest
   * outcome is `BUSY`, and asking again records exactly that.
   */
  private async createUnlessBusy(orderId: string, callable: CallableOrder) {
    const master = callable.caller.kind === 'master' ? callable.caller : callable.callee;
    const input = {
      orderId,
      caller: callable.caller,
      callee: callable.callee,
      masterId: master.id,
      isCallableStatus: isWritableStatus,
    };
    try {
      return await this.calls.createUnlessBusy(input);
    } catch (error) {
      if (!isUniqueViolationOn(error, 'calls_one_live_per_order')) {
        throw error;
      }
      return this.calls.createUnlessBusy(input);
    }
  }

  private async scheduleTimeout(callId: string): Promise<void> {
    try {
      await this.deferredWork.schedule(
        CALL_RING_TIMEOUT_JOB,
        { callId },
        {
          delayMs: this.config.calls.signalling.ringTimeoutSeconds * 1000,
          jobId: callRingTimeoutJobId(callId),
        },
      );
    } catch (error) {
      // The call still rings, and either party can still end it — the callee
      // by declining, the caller by cancelling. What is lost is the deadline,
      // and the sweep in #186 is what finds a call left ringing past it.
      // Failing the invite instead would leave the row ringing *and* tell the
      // caller it did not.
      this.logger.error(
        `scheduling the ring timeout for call ${callId} failed: ${describe(error)}`,
      );
    }
  }

  /**
   * Closes an answered call's media room. **Best effort**: the call is over
   * in the database whatever happens here, and `deleteRoom` is idempotent, so
   * #186's reaper can finish the job.
   */
  private async closeRoom(callId: string): Promise<void> {
    try {
      await this.media.deleteRoom(callRoomName(callId));
    } catch (error) {
      this.logger.warn(`closing the media room for call ${callId} failed: ${describe(error)}`);
    }
  }

  /**
   * Signs a credential for one side of an accepted call. Its callers have
   * established that the call is `ACCEPTED` and that the actor is this side;
   * the port signs what it is told (`call-media.types.ts`), which is why it is
   * only ever reached through them.
   */
  private async credentialFor(call: CallRow, role: CallSide): Promise<CallJoinCredential> {
    const self = role === 'caller' ? callerOf(call) : calleeOf(call);
    const peer = role === 'caller' ? calleeOf(call) : callerOf(call);
    const identity = participantIdentity(self.kind, self.id);

    const credential = await this.media.mintJoinToken({ roomName: call.roomName, identity });

    return {
      callId: call.id,
      token: credential.token,
      url: credential.url,
      expiresAt: credential.expiresAt.toISOString(),
      identity,
      peerIdentity: participantIdentity(peer.kind, peer.id),
    };
  }

  /**
   * Both parties' profile names, for presenting the call to each.
   *
   * **Never fatal.** It runs after a transition has committed, and a name is
   * decoration on a frame whose substance is the call's status: a lookup that
   * fails must not stop the frames, the room close or the ok ack that the
   * committed transition is owed. The peer is shown without a name instead —
   * which `Call.peer.displayName` already allows for.
   */
  private async namesFor(call: CallRow): Promise<PartyNames> {
    const customerId = call.callerKind === 'customer' ? call.callerId : call.calleeId;
    const masterId = call.callerKind === 'master' ? call.callerId : call.calleeId;
    try {
      const [customer, master] = await Promise.all([
        this.customers.findDisplayName(customerId),
        this.masters.findDisplayName(masterId),
      ]);
      return { customer: customer ?? null, master: master ?? null };
    } catch (error) {
      this.logger.warn(
        `looking up the party names for call ${call.id} failed; presenting it without them: ${describe(error)}`,
      );
      return { customer: null, master: null };
    }
  }

  private delivery(
    event: CallRealtimeEventName,
    call: CallRow,
    to: CallSide,
    names: PartyNames,
  ): CallDelivery {
    return {
      event,
      userId: to === 'caller' ? call.callerUserId : call.calleeUserId,
      payload: { call: present(call, to, names), at: Date.now() },
    };
  }

  /** The same fact to both parties, each seeing the call as theirs. */
  private toBoth(event: CallRealtimeEventName, call: CallRow, names: PartyNames): CallDelivery[] {
    return [
      this.delivery(event, call, 'caller', names),
      this.delivery(event, call, 'callee', names),
    ];
  }
}

interface PartyNames {
  readonly customer: string | null;
  readonly master: string | null;
}

function callerOf(call: CallRow): { kind: CallPartyKind; id: string } {
  return { kind: call.callerKind, id: call.callerId };
}

function calleeOf(call: CallRow): { kind: CallPartyKind; id: string } {
  return { kind: call.calleeKind, id: call.calleeId };
}

/**
 * Who a party is inside the media room: their side and their profile id.
 * Never an account id, never a phone number — the other participant can read
 * it, and #186's webhook matches it back to the call's row.
 */
export function participantIdentity(kind: CallPartyKind, profileId: string): string {
  return `${kind}:${profileId}`;
}

/** Whether the call's parties are still the order's two parties. */
function sameParties(callable: CallableOrder, call: CallRow): boolean {
  const parties = [callable.caller, callable.callee];
  return (
    parties.some((p) => p.kind === call.callerKind && p.id === call.callerId) &&
    parties.some((p) => p.kind === call.calleeKind && p.id === call.calleeId)
  );
}

/** One call row as one of its parties sees it. See `Call` in `packages/types`. */
function present(call: CallRow, viewer: CallSide, names: PartyNames): Call {
  const peerKind = viewer === 'caller' ? call.calleeKind : call.callerKind;
  return {
    id: call.id,
    orderId: call.orderId,
    status: call.status,
    endReason: call.endReason,
    role: viewer,
    peer: { kind: peerKind, displayName: names[peerKind] },
    startedAt: call.startedAt.toISOString(),
    answeredAt: call.answeredAt === null ? null : call.answeredAt.toISOString(),
    endedAt: call.endedAt === null ? null : call.endedAt.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
