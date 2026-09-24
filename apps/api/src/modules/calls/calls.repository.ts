import { Inject, Injectable } from '@nestjs/common';
import type { CallEndReason, CallPartyKind, CallStatus, OrderStatus } from '@tezusta/types';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq, gte, inArray, lt, notInArray, or, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { CallRow } from '../../infra/database/schema/calls';
import { calls, LIVE_CALL_STATUSES } from '../../infra/database/schema/calls';
import { customers } from '../../infra/database/schema/customers';
import { masters } from '../../infra/database/schema/masters';
import { orders } from '../../infra/database/schema/orders';
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
/** One call with both parties' profile names, read in the same query. */
export interface CallRecordRow {
  readonly call: CallRow;
  readonly customerName: string | null;
  readonly masterName: string | null;
}

/**
 * What a call listing may be narrowed by. Every field is optional and they
 * combine with `AND`; the party ones are the profile on the order, never an
 * account.
 */
export interface CallRecordFilter {
  readonly orderId?: string | undefined;
  readonly status?: CallStatus | undefined;
  /** Inclusive lower bound on `started_at`. */
  readonly startedFrom?: Date | undefined;
  /** Exclusive upper bound on `started_at`. */
  readonly startedBefore?: Date | undefined;
  readonly masterId?: string | undefined;
  readonly customerId?: string | undefined;
  /** Only calls this account was on, either side — the party history's rule. */
  readonly partyUserId?: string | undefined;
}

export interface CallRecordPage {
  readonly rows: readonly CallRecordRow[];
  /** The id the next page resumes after, or null on the last page. */
  readonly nextCursorId: string | null;
}

export type CreateCallOutcome =
  | { readonly kind: 'ringing'; readonly call: CallRow }
  | { readonly kind: 'busy'; readonly call: CallRow }
  /** The order stopped being callable before the insert; nothing was written. */
  | { readonly kind: 'order-closed' };

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
    /** The master the caller found assigned to the order. */
    readonly masterId: string;
    /** Whether an order in this status may be called about — the service's rule, passed in. */
    readonly isCallableStatus: (status: OrderStatus) => boolean;
  }): Promise<CreateCallOutcome> {
    return this.db.transaction(async (tx) => {
      // **The order again, inside the transaction, `FOR SHARE`.** The service
      // decided the order was callable before this began; an order closed in
      // between would otherwise get a RINGING call nothing ends — the close's
      // hook ran before this row existed. `FOR SHARE` serialises the two: a
      // transition that has not committed waits for this insert (and its hook
      // then ends the call), and one that has is seen here and refused. The
      // master is compared too, because a re-dispatch clears `master_id` and a
      // re-accept names a different one.
      const [order] = await tx
        .select({ status: orders.status, masterId: orders.masterId })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for('share');
      if (
        order === undefined ||
        !input.isCallableStatus(order.status) ||
        order.masterId !== input.masterId
      ) {
        return { kind: 'order-closed' } as const;
      }

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

  /** The call a media room belongs to — the webhook's lookup, on `calls_room_name_unique`. */
  async findByRoomName(roomName: string): Promise<CallRow | undefined> {
    const [row] = await this.db.select().from(calls).where(eq(calls.roomName, roomName));
    return row;
  }

  /** The statuses of the named calls, for the reaper's orphaned-room check. One query. */
  async findStatuses(ids: readonly string[]): Promise<Map<string, CallStatus>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ id: calls.id, status: calls.status })
      .from(calls)
      .where(inArray(calls.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  /**
   * `ACCEPTED` calls answered before `answeredBefore`, oldest first, whose
   * room is not one of `excludingRooms` — the reaper's worklist, on
   * `calls_accepted_answered_idx`. Ids and room names
   * only: the reaper re-decides every row through a conditional `UPDATE`, so
   * anything more read here would be stale by the time it mattered.
   */
  async listAnsweredBefore(
    answeredBefore: Date,
    limit: number,
    excludingRooms?: readonly string[],
  ): Promise<readonly { readonly id: string; readonly roomName: string }[]> {
    return this.db
      .select({ id: calls.id, roomName: calls.roomName })
      .from(calls)
      .where(
        and(
          eq(calls.status, 'ACCEPTED'),
          lt(calls.answeredAt, answeredBefore),
          // Filtered in the query rather than after it: a busy evening's
          // live calls, all with rooms, would otherwise fill every batch and
          // keep the dead one behind them from ever being looked at.
          excludingRooms === undefined || excludingRooms.length === 0
            ? undefined
            : notInArray(calls.roomName, [...excludingRooms]),
        ),
      )
      .orderBy(calls.answeredAt)
      .limit(limit);
  }

  /** `RINGING` calls invited before `startedBefore`, oldest first, on `calls_ringing_started_idx`. */
  async listRingingBefore(startedBefore: Date, limit: number): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.status, 'RINGING'), lt(calls.startedAt, startedBefore)))
      .orderBy(calls.startedAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * One page of calls with both parties' names, newest first, resumed after
   * `afterCallId` — the read behind the admin list and a party's history.
   *
   * **Names by join, not per row.** The customer and the master are each one
   * of the two party columns depending on who rang whom, so each join is on a
   * `CASE`; `calls_parties_differ` guarantees exactly one side is each kind.
   * A left join, because a deleted profile must not hide the call it was on.
   *
   * The cursor is resolved to `(started_at, id)` in a subquery, at the
   * column's precision (`call-cursor.ts`), and compared as a row value so the
   * `(started_at desc, id desc)` order has no ties.
   */
  async listRecords(input: {
    readonly filter: CallRecordFilter;
    readonly limit: number;
    readonly afterCallId: string | null;
  }): Promise<CallRecordPage> {
    const { filter, limit, afterCallId } = input;
    const customerId = sql`case when ${calls.callerKind} = 'customer' then ${calls.callerId} else ${calls.calleeId} end`;
    const masterId = sql`case when ${calls.callerKind} = 'master' then ${calls.callerId} else ${calls.calleeId} end`;

    const conditions: (SQL | undefined)[] = [
      filter.orderId === undefined ? undefined : eq(calls.orderId, filter.orderId),
      filter.status === undefined ? undefined : eq(calls.status, filter.status),
      filter.startedFrom === undefined ? undefined : gte(calls.startedAt, filter.startedFrom),
      filter.startedBefore === undefined ? undefined : lt(calls.startedAt, filter.startedBefore),
      filter.masterId === undefined ? undefined : partyIs('master', filter.masterId),
      filter.customerId === undefined ? undefined : partyIs('customer', filter.customerId),
      filter.partyUserId === undefined
        ? undefined
        : or(
            eq(calls.callerUserId, filter.partyUserId),
            eq(calls.calleeUserId, filter.partyUserId),
          ),
      afterCallId === null
        ? undefined
        : sql`(${calls.startedAt}, ${calls.id}) < (
            select ${calls.startedAt}, ${calls.id} from ${calls} where ${calls.id} = ${afterCallId}
          )`,
    ];

    const rows = await this.db
      .select({ call: calls, customerName: customers.displayName, masterName: masters.displayName })
      .from(calls)
      .leftJoin(customers, eq(customers.id, customerId))
      .leftJoin(masters, eq(masters.id, masterId))
      .where(and(...conditions))
      .orderBy(desc(calls.startedAt), desc(calls.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursorId: rows.length > limit && last !== undefined ? last.call.id : null,
    };
  }
}

/**
 * "This profile was on the call, on this side" — an `OR` over the two party
 * columns, so each half can use its own `(…_id, started_at desc)` index.
 */
function partyIs(kind: CallPartyKind, profileId: string): SQL | undefined {
  return or(
    and(eq(calls.callerKind, kind), eq(calls.callerId, profileId)),
    and(eq(calls.calleeKind, kind), eq(calls.calleeId, profileId)),
  );
}
