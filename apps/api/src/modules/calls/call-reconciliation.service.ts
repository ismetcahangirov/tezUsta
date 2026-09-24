import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import { CALL_MEDIA_PROVIDER, CallMediaUnavailableError } from '../../infra/calls/call-media.types';
import type { CallMediaProvider, WebhookDelivery } from '../../infra/calls/call-media.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import { isTerminalCallStatus } from './call-lifecycle';
import { CallsRepository } from './calls.repository';
import { CallsService } from './calls.service';

/**
 * The recurring job that reconciles live calls against the media server. Its
 * name is also its scheduler's id in Redis, so renaming it follows
 * `maintenance.constants.ts`' rule: stop the old id in the release that
 * introduces the new one.
 */
export const CALL_REAPER_JOB = 'call-reaper';

/**
 * How long after an answer a call's room must exist before its absence means
 * anything.
 *
 * LiveKit creates a room when its first participant connects, not when the
 * token is minted, so for the first seconds of every answered call "no room"
 * is the normal state. A minute covers a callee on a slow network joining and
 * the caller fetching its credential from `POST /calls/:id/join`; a room that
 * has not appeared a full minute after the answer is not coming, and the two
 * people are sitting `BUSY` for nothing.
 */
export const ANSWERED_ROOM_GRACE_SECONDS = 60;

/**
 * How far past `CALL_RING_TIMEOUT_SECONDS` a `RINGING` call must be before
 * the reaper times it out itself. The delayed job is the mechanism; this is
 * the backstop for the invite whose job failed to schedule (#185) or that
 * Redis lost. The margin covers that job's own retry backoff, so the two do
 * not routinely race — and when they do, the conditional update settles it.
 */
export const RING_TIMEOUT_MARGIN_SECONDS = 30;

/**
 * The most calls one sweep looks at per worklist, and the most rooms it
 * deletes. A healthy system finds none, so this is not a throughput knob: it
 * is the ceiling on what an incident — a LiveKit restart that dropped every
 * room, a week of lost webhooks — can ask of one worker slot. The rest waits
 * one interval.
 */
export const MAX_CALLS_PER_SWEEP = 200;
export const MAX_ROOMS_PER_SWEEP = 100;

/** A room name this system issued: `call-<uuid>`, as `callRoomName` derives it. */
const CALL_ROOM_NAME = /^call-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** What one sweep did. Counts only — never an id of a person or a call. */
export interface CallSweepReport {
  readonly timedOut: number;
  readonly reaped: number;
  readonly roomGone: number;
  readonly roomsClosed: number;
  /** True when LiveKit could not be asked, and the room checks were skipped. */
  readonly mediaUnavailable: boolean;
}

/** What the webhook endpoint answers with, and what it did about it. */
export type WebhookOutcome = 'invalid' | 'ignored' | 'applied' | 'no-op';

/**
 * Reconciles the persisted call state against what the media server actually
 * has (issue #186, ADR-0034 § 4) — the half of calling that ends the calls
 * nobody hung up.
 *
 * **Two inputs, and only one of them is trusted to be there.**
 *
 * - **The webhook** is the fast path: LiveKit tells us a room finished, and
 *   the call ends within a second. It is also the unreliable one — LiveKit's
 *   own documentation says "there are no guarantees around delivery" — so it
 *   is treated as an optimisation, never as the mechanism.
 * - **The reaper** is the mechanism. It needs no client and no webhook: every
 *   interval it asks LiveKit which rooms exist and ends every answered call
 *   whose room does not. It has to be correct on its own, and it is written as
 *   if the webhook did not exist.
 *
 * **They race, and both may fire twice; neither needs to know.** Every end
 * goes through `CallsService.endAnsweredBySystem`, one conditional
 * `ACCEPTED → ENDED` whose loser changes nothing and publishes nothing. So a
 * replayed webhook, a sweep overlapping a webhook, and a retry of a sweep
 * that half-failed all converge on one ended row and one `call:ended`. That is
 * also why the webhook keeps no event-id ledger: deduplicating deliveries
 * would be a Redis key per event to protect a write that is already
 * idempotent by construction.
 *
 * **On the maintenance queue, not an in-process interval**, per ADR-0025 and
 * CLAUDE.md §12: a scheduler upserted by every replica, whose each iteration
 * one worker in the fleet runs.
 */
@Injectable()
export class CallReconciliationService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(CallReconciliationService.name);

  constructor(
    private readonly calls: CallsRepository,
    private readonly signalling: CallsService,
    @Inject(CALL_MEDIA_PROVIDER) private readonly media: CallMediaProvider,
    private readonly recurring: RecurringWorkService,
    private readonly handlers: DeferredJobHandlerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.handlers.register(CALL_REAPER_JOB, async () => {
      await this.sweep();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.calls.signalling.reaperIntervalSeconds;

    if (seconds === 0) {
      // Zero must mean "nothing is scheduled", not "this release did not
      // schedule": a scheduler left by an earlier release keeps producing
      // jobs otherwise. `stop` on one that never existed is a no-op.
      await this.recurring.stop(CALL_REAPER_JOB);
      this.logger.log('CALL_REAPER_INTERVAL_SECONDS=0 — live calls are not reconciled');
      return;
    }

    await this.recurring.every(CALL_REAPER_JOB, seconds * 1000);
  }

  /**
   * A LiveKit webhook: **verify first, then act** — nothing is read from the
   * database, and nothing about the delivery is trusted, until the provider
   * has proven LiveKit sent it.
   *
   * Only `room-finished` changes anything, and only for an `ACCEPTED` call:
   * the room is gone, so the call is over (`room_gone`). A `RINGING` call has
   * no room — no credential exists before an answer — so a room event naming
   * one says nothing about it.
   *
   * **`participant-left` deliberately changes nothing.** A participant leaving
   * is also what a Wi-Fi-to-cellular handover looks like, and ADR-0034 § 4
   * names ending calls on transient disconnects as a failure mode to design
   * out. The party who actually left for good is covered three ways without
   * this: the remaining app sees its peer leave and hangs up after its own
   * grace; if both are gone, LiveKit closes the empty room and `room-finished`
   * arrives; and if that is lost, the reaper finds the room missing. Asking
   * LiveKit "is anyone still here?" on every leave would be one RoomService
   * round trip per disconnect to learn what `room-finished` states outright.
   * `participant-joined` changes nothing either: joining is not a transition.
   */
  async applyWebhook(delivery: WebhookDelivery): Promise<WebhookOutcome> {
    const verification = await this.media.verifyWebhook(delivery);

    if (verification.status === 'invalid') {
      return 'invalid';
    }
    if (verification.status === 'ignored') {
      return 'ignored';
    }

    const { event } = verification;
    if (event.type !== 'room-finished') {
      return 'no-op';
    }

    const call = await this.calls.findByRoomName(event.roomName);
    if (call?.status !== 'ACCEPTED') {
      // Not our room, a call already ended by a hangup or by the reaper, or a
      // replay of this very delivery. All are "nothing left to do".
      return 'no-op';
    }

    // The room is already gone, so there is nothing to delete.
    const ended = await this.signalling.endAnsweredBySystem(call.id, 'room_gone', {
      closeRoom: false,
    });
    return ended ? 'applied' : 'no-op';
  }

  /**
   * One pass. In order, and the order is the design:
   *
   * 1. **Ringing past its deadline → `TIMED_OUT`.** Needs nothing from LiveKit.
   * 2. **Answered longer than `CALL_MAX_DURATION_MINUTES` → `reaped`**, and
   *    its room closed. Needs nothing from LiveKit to decide either — the cap
   *    must hold when LiveKit is the thing that is broken.
   * 3. **Ask LiveKit which rooms exist.** If it cannot be asked, **stop**:
   *    every remaining step would read "could not ask" as "no rooms" and end
   *    every live call in the city. Nothing after this line runs on a guess.
   * 4. **Answered over a minute ago with no room → `room_gone`** — the
   *    force-killed client: nobody hung up, the room emptied and closed, and
   *    the webhook saying so was lost.
   * 5. **A room whose call is over, or was never ours to have → deleted.**
   *    A hangup's `deleteRoom` that failed, or a join racing an order closing
   *    underneath it — LiveKit re-creates a room on join, so a credential
   *    minted as the call ended can open a room for a call that is `ENDED`.
   *
   * The cutoff for step 4 is taken **before** the rooms are listed, so a
   * room created between the two reads belongs to a call answered after the
   * cutoff and is never judged by a snapshot older than itself.
   */
  async sweep(): Promise<CallSweepReport> {
    const now = Date.now();
    const { ringTimeoutSeconds, maxDurationMinutes } = this.config.calls.signalling;

    const timedOut = await this.timeOutOverdueRinging(
      new Date(now - (ringTimeoutSeconds + RING_TIMEOUT_MARGIN_SECONDS) * 1000),
    );
    const reaped = await this.reapOverlong(new Date(now - maxDurationMinutes * 60_000));
    const answeredBefore = new Date(now - ANSWERED_ROOM_GRACE_SECONDS * 1000);

    let liveRooms: ReadonlySet<string>;
    try {
      liveRooms = new Set((await this.media.listRooms()).map((room) => room.name));
    } catch (error) {
      if (!(error instanceof CallMediaUnavailableError)) {
        throw error;
      }
      // `warn`, and every interval it lasts: this is the state in which dead
      // calls stop being ended, and an operator has to be able to see it.
      this.logger.warn(
        `Call reaper: the media server could not be asked for its rooms; no call was ended for a missing room`,
      );
      const report = { timedOut, reaped, roomGone: 0, roomsClosed: 0, mediaUnavailable: true };
      this.log(report);
      return report;
    }

    let roomGone = 0;
    const roomless = await this.calls.listAnsweredBefore(answeredBefore, MAX_CALLS_PER_SWEEP, [
      ...liveRooms,
    ]);
    for (const call of roomless) {
      if (await this.signalling.endAnsweredBySystem(call.id, 'room_gone', { closeRoom: false })) {
        roomGone += 1;
      }
    }

    const roomsClosed = await this.closeOrphanedRooms(liveRooms);

    const report = { timedOut, reaped, roomGone, roomsClosed, mediaUnavailable: false };
    this.log(report);
    return report;
  }

  private async timeOutOverdueRinging(startedBefore: Date): Promise<number> {
    const overdue = await this.calls.listRingingBefore(startedBefore, MAX_CALLS_PER_SWEEP);
    let count = 0;
    for (const callId of overdue) {
      // The ring-timeout job's own handler: the same conditional
      // `RINGING → TIMED_OUT` and the same `call:timeout`, so a job that
      // turns up late after all finds nothing and says nothing.
      await this.signalling.timeOut({ callId });
      const after = await this.calls.findById(callId);
      if (after?.status === 'TIMED_OUT') {
        count += 1;
      }
    }
    return count;
  }

  private async reapOverlong(answeredBefore: Date): Promise<number> {
    let count = 0;
    for (const call of await this.calls.listAnsweredBefore(answeredBefore, MAX_CALLS_PER_SWEEP)) {
      if (await this.signalling.endAnsweredBySystem(call.id, 'reaped', { closeRoom: true })) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Deletes rooms named like ours whose call is terminal, or has no row at
   * all. **A `RINGING` call's room is left alone**: it cannot legitimately
   * exist, but deleting it is the one step here that could race an answer.
   *
   * "No row" assumes this LiveKit serves one environment. A server shared by
   * two deployments would have each delete the other's rooms; ADR-0034 gives
   * each environment its own, and this is where that assumption is load-bearing.
   */
  private async closeOrphanedRooms(liveRooms: ReadonlySet<string>): Promise<number> {
    const byCallId = new Map<string, string>();
    for (const name of liveRooms) {
      const match = CALL_ROOM_NAME.exec(name);
      if (match?.[1] !== undefined) {
        byCallId.set(match[1], name);
      }
      if (byCallId.size >= MAX_ROOMS_PER_SWEEP) {
        break;
      }
    }

    const statuses = await this.calls.findStatuses([...byCallId.keys()]);
    let closed = 0;
    for (const [callId, roomName] of byCallId) {
      const status = statuses.get(callId);
      if (status !== undefined && !isTerminalCallStatus(status)) {
        continue;
      }
      try {
        await this.media.deleteRoom(roomName);
        closed += 1;
      } catch (error) {
        // Best effort, and the next sweep tries again: the room is still
        // listed, and its call is still over.
        this.logger.warn(
          `Call reaper: closing an orphaned room failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return closed;
  }

  private log(report: CallSweepReport): void {
    const { timedOut, reaped, roomGone, roomsClosed } = report;
    if (timedOut + reaped + roomGone + roomsClosed === 0) {
      // The normal outcome, and silent, like the dispatch reconciler's.
      return;
    }
    this.logger.log(
      `Call reaper: ${String(timedOut)} timed out, ${String(reaped)} over the duration cap, ` +
        `${String(roomGone)} ended with their room gone, ${String(roomsClosed)} orphaned rooms closed`,
    );
  }
}
