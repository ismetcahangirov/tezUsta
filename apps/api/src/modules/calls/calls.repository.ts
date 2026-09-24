import { Inject, Injectable } from '@nestjs/common';
import type { CallEndReason, CallPartyKind, CallStatus } from '@tezusta/types';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { CallRow } from '../../infra/database/schema/calls';
import { calls, LIVE_CALL_STATUSES } from '../../infra/database/schema/calls';
import { isEndReasonFor, isTerminalCallStatus } from './call-lifecycle';

/** One side of a call as the row records it. */
export interface CallParty {
  readonly kind: CallPartyKind;
  /** The customer id or the master id — the party *on the order*. */
  readonly id: string;
  /** The account behind it — what "busy" is decided on. */
  readonly userId: string;
}

/**
 * Whether the invite rang or met a busy line. **Both are rows**: a `BUSY` call
 * is inserted terminal, so the refused attempt is on the record (#186).
 */
export type CreateCallOutcome =
  | { readonly kind: 'ringing'; readonly call: CallRow }
  | { readonly kind: 'busy'; readonly call: CallRow };

/**
 * The room a call's media lives in, derived from its id. **Never
 * client-supplied** (issue #185): nothing a device sends can become a room
 * name, so a device can only ever be handed a credential for a call it is a
 * party to. `calls_room_name_derived` holds the stored column to this rule.
 */
export function callRoomName(callId: string): string {
  return `call-${callId}`;
}

/**
 * The advisory-lock key for one account's calls. A string hashed by Postgres
 * rather than something computed here, so every instance — and #186's reaper,
 * whatever it is written in — derives the same lock from the same account.
 * The prefix keeps it from colliding with any other advisory lock this
 * database might one day take on a user id; a hash collision between two
 * accounts only serialises two unrelated invites, which is harmless.
 */
function partyLockKey(userId: string): string {
  return `call-party:${userId}`;
}

/**
 * Drizzle queries for `calls`. No rules about which edge is legal — that is
 * `call-lifecycle.ts`'s answer — but every write here is **conditional on the
 * status it expects**, which is what makes the answer still true when the row
 * moves: a ring timeout, a hangup and #186's webhook will race the same rows,
 * and exactly one of them changes each.
 */
@Injectable()
export class CallsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Records an invite — as `RINGING` if neither account is on a live call,
   * and as `BUSY` if either is.
   *
   * **Busy is a concurrency problem, not a lookup** (issue #185). A `SELECT`
   * for a live call followed by an `INSERT` lets two invites arriving together
   * both see nothing and both ring — A→B twice from a double tap, or A→B and
   * B→A at the same moment. So the transaction first takes a
   * `pg_advisory_xact_lock` on **both** accounts, and only then looks:
   *
   * - **Both** accounts, because either being on a call makes the line busy,
   *   and an invite from B that locked only B would not wait for one from A
   *   that locked only A.
   * - **In sorted order**, so two invites needing the same two locks take
   *   them in the same sequence and one waits for the other rather than each
   *   holding one and waiting forever.
   * - **Transaction-scoped**, so the locks are released by the commit that
   *   makes the new row visible — the waiting invite then reads it under READ
   *   COMMITTED, because each statement takes a fresh snapshot.
   *
   * `calls_one_live_per_order` is the second line: a writer that ever skips
   * these locks fails on the index instead of ringing twice.
   */
  async createUnlessBusy(input: {
    readonly orderId: string;
    readonly caller: CallParty;
    readonly callee: CallParty;
  }): Promise<CreateCallOutcome> {
    return this.db.transaction(async (tx) => {
      const keys = [input.caller.userId, input.callee.userId].map(partyLockKey).sort();
      for (const key of keys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      }

      const accounts = [input.caller.userId, input.callee.userId];
      const [live] = await tx
        .select({ id: calls.id })
        .from(calls)
        .where(
          and(
            inArray(calls.status, LIVE_CALL_STATUSES),
            or(inArray(calls.callerUserId, accounts), inArray(calls.calleeUserId, accounts)),
          ),
        )
        .limit(1);

      const id = uuidV7();
      const busy = live !== undefined;
      const now = new Date();

      const [row] = await tx
        .insert(calls)
        .values({
          id,
          orderId: input.orderId,
          callerKind: input.caller.kind,
          callerId: input.caller.id,
          callerUserId: input.caller.userId,
          calleeKind: input.callee.kind,
          calleeId: input.callee.id,
          calleeUserId: input.callee.userId,
          status: busy ? 'BUSY' : 'RINGING',
          roomName: callRoomName(id),
          startedAt: now,
          endedAt: busy ? now : null,
          endReason: busy ? 'busy' : null,
        })
        .returning();

      if (row === undefined) {
        throw new Error('INSERT … RETURNING returned no row for a new call');
      }

      return busy ? { kind: 'busy', call: row } : { kind: 'ringing', call: row };
    });
  }

  async findById(id: string): Promise<CallRow | undefined> {
    const [row] = await this.db.select().from(calls).where(eq(calls.id, id));
    return row;
  }

  /**
   * Moves one call from `from` to `to`, **only if it is still in `from`**.
   *
   * `undefined` means the conditional `UPDATE` matched nothing: somebody else
   * moved the call first — the caller cancelled as the callee answered, the
   * timeout fired as the phone was picked up. The caller re-reads and reports
   * what actually happened; nothing here retries, because the edge that lost
   * is by definition no longer legal.
   *
   * The timestamps follow the target: `ACCEPTED` stamps `answered_at`, and
   * every terminal status stamps `ended_at` and its reason — the pairing
   * `calls_end_matches_status` also holds the database to.
   */
  async transition(input: {
    readonly callId: string;
    readonly from: CallStatus;
    readonly to: CallStatus;
    readonly endReason?: CallEndReason | undefined;
    readonly at?: Date;
  }): Promise<CallRow | undefined> {
    const at = input.at ?? new Date();
    const terminal = isTerminalCallStatus(input.to);

    if (terminal && (input.endReason === undefined || !isEndReasonFor(input.to, input.endReason))) {
      throw new Error(`A call cannot finish as ${input.to} for reason ${String(input.endReason)}`);
    }

    const [row] = await this.db
      .update(calls)
      .set({
        status: input.to,
        ...(input.to === 'ACCEPTED' ? { answeredAt: at } : {}),
        ...(terminal ? { endedAt: at, endReason: input.endReason } : {}),
      })
      .where(and(eq(calls.id, input.callId), eq(calls.status, input.from)))
      .returning();

    return row;
  }

  /**
   * Ends whatever call is live on an order, because the order stopped being
   * one a call can be about (ADR-0034 § 6).
   *
   * One conditional `UPDATE` over both live statuses rather than a read and a
   * `transition` per row: `RINGING → ENDED` and `ACCEPTED → ENDED` are both
   * the system's edges, and a read first would be one more window for the
   * call to move. `calls_one_live_per_order` means this returns at most one
   * row; it is typed as a list because the index, not this method, is what
   * guarantees that.
   *
   * `wasAnswered` is returned alongside, because whether the call had been
   * answered decides whether there is a media room to close.
   */
  async endLiveForOrder(
    orderId: string,
    reason: CallEndReason,
    at: Date = new Date(),
  ): Promise<readonly { readonly call: CallRow; readonly wasAnswered: boolean }[]> {
    const ended = await this.db
      .update(calls)
      .set({ status: 'ENDED', endedAt: at, endReason: reason })
      .where(and(eq(calls.orderId, orderId), inArray(calls.status, LIVE_CALL_STATUSES)))
      .returning();

    return ended.map((call) => ({ call, wasAnswered: call.answeredAt !== null }));
  }
}
