import type { CallEndReason, CallPartyKind, CallStatus } from '@tezusta/types';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { orders } from './orders';
import { users } from './users';

/**
 * Where a call is in its life (issue #185). The legal edges between these are
 * `modules/calls/call-lifecycle.ts`'s, and nowhere else's.
 *
 * A Postgres enum for the reason `order_status` is one: the set is closed and
 * the database should refuse a typo rather than store it.
 */
export const callStatus = pgEnum('call_status', [
  'RINGING',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'TIMED_OUT',
  'BUSY',
  'ENDED',
]);

/**
 * Why a call finished. `room_gone` and `reaped` are written by #186's webhook
 * and reaper, and are in the enum from the start so that issue adds behaviour
 * rather than a migration that rewrites a type other code already reads.
 */
export const callEndReason = pgEnum('call_end_reason', [
  'declined',
  'cancelled',
  'no_answer',
  'busy',
  'hangup',
  'order_closed',
  'room_gone',
  'reaped',
]);

/**
 * Which side of the order a party is on. Its own enum rather than a reuse of
 * `message_sender_kind`, although the values are the same two strings: that
 * type means "who wrote a message", and the day one of the two concepts gains
 * a value the other must not silently gain it too.
 */
export const callPartyKind = pgEnum('call_party_kind', ['customer', 'master']);

/**
 * The two statuses in which a call is live. **Written twice and one fact**: the
 * other copy is the predicate of the partial indexes below, which has to be
 * literal SQL a migration can diff. `call-lifecycle.ts` derives its own list
 * from the transition table, and `call-lifecycle.test.ts` asserts the two agree.
 */
export const LIVE_CALL_STATUSES = ['RINGING', 'ACCEPTED'] as const satisfies readonly CallStatus[];

const LIVE = sql.raw(`('RINGING', 'ACCEPTED')`);

/**
 * One call between the two parties to one order
 * ([ADR-0034](docs/decisions/ADR-0034-in-app-voice-calls.md) § 4, issue #185).
 *
 * **A row exists from the invite and records every transition**, including a
 * refused one: an invite that met a busy line is a `BUSY` row, so an admin
 * reading an order's calls (#186) sees the attempt rather than a gap.
 *
 * **Two identities per party, on purpose.** `caller_kind`/`caller_id` is the
 * party *on the order* — a customer id or a master id, which is what the order
 * holds and what an admin reads. `caller_user_id` is the *account*, which is
 * what "busy" means — one human, one call, whichever profile they happen to be
 * calling from — and what the socket delivers to. Deriving the account from
 * the profile on every busy check would put a join on the one query that runs
 * under a lock; storing it costs a column and cannot drift, because a profile's
 * `user_id` never changes.
 *
 * `caller_id` and `callee_id` carry no foreign key: each names a row in one of
 * two tables depending on its kind, which a foreign key cannot express. The
 * account columns carry one, and the order column does.
 */
export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    callerKind: callPartyKind('caller_kind').notNull(),
    callerId: uuid('caller_id').notNull(),
    callerUserId: uuid('caller_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    calleeKind: callPartyKind('callee_kind').notNull(),
    calleeId: uuid('callee_id').notNull(),
    calleeUserId: uuid('callee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    status: callStatus('status').notNull(),

    /**
     * The media room, **derived from the id and never client-supplied**
     * (issue #185). Stored anyway, because #186's webhook arrives naming a
     * room and has to find the call it belongs to by an indexed equality, and
     * because a derivation rule that changed later would otherwise orphan
     * every room already open. The CHECK below holds it to the rule.
     */
    roomName: text('room_name').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: callEndReason('end_reason'),
  },
  (table) => [
    /**
     * **One live call per order — the second line of defence.** The first is
     * the advisory lock on both parties' accounts that the invite takes before
     * it looks (`calls.repository.ts#createUnlessBusy`); this is what makes a
     * future writer that forgets the lock fail loudly instead of ringing twice.
     * An order has exactly two parties, so this also covers the A→B / B→A race
     * on its own.
     */
    uniqueIndex('calls_one_live_per_order')
      .on(table.orderId)
      .where(sql`${table.status} in ${LIVE}`),

    /**
     * "Is this account on a live call?" — asked from both sides, so both
     * columns get a partial index holding only the live rows, which in a
     * healthy system is a handful however many calls have ever been made.
     */
    index('calls_live_caller_user_idx')
      .on(table.callerUserId)
      .where(sql`${table.status} in ${LIVE}`),
    index('calls_live_callee_user_idx')
      .on(table.calleeUserId)
      .where(sql`${table.status} in ${LIVE}`),

    /**
     * The foreign keys Postgres does not index on its own, **unconditionally**.
     * The partial indexes above hold live rows only, so they cannot serve the
     * FK check a `users` delete or key update runs against every call — nor
     * "this account's calls" for #186's history. Without these, both are a
     * sequential scan of the whole table.
     */
    index('calls_caller_user_idx').on(table.callerUserId),
    index('calls_callee_user_idx').on(table.calleeUserId),

    /**
     * An order's calls, newest first — the read behind an admin's call record
     * (#186), and the lookup that ends an order's live call when the order
     * closes. A plain `desc` in `sql` for the reason `messages` spells its
     * index that way: drizzle's `.desc()` emits `NULLS LAST`, which a bare
     * `ORDER BY … DESC` cannot use.
     */
    index('calls_order_started_idx').on(table.orderId, sql`${table.startedAt} desc`),

    /** #186's webhook finds a call by the room it names. */
    uniqueIndex('calls_room_name_unique').on(table.roomName),

    check('calls_room_name_derived', sql`${table.roomName} = 'call-' || ${table.id}::text`),

    /** A call is between the two sides of an order, never one side twice. */
    check('calls_parties_differ', sql`${table.callerKind} <> ${table.calleeKind}`),

    /**
     * **A live call has no end, and a finished one has both an end and a
     * reason.** Held by the database so a writer that sets one and forgets the
     * other — #186's reaper, a hand-written fix — fails rather than leaving a
     * row nothing can interpret.
     */
    check(
      'calls_end_matches_status',
      sql`(${table.status} in ${LIVE}) = (${table.endedAt} is null and ${table.endReason} is null)`,
    ),

    /** Answered exactly when it reached `ACCEPTED` — which `ENDED` may have. */
    check(
      'calls_answer_matches_status',
      sql`(${table.status} = 'ACCEPTED' and ${table.answeredAt} is not null)
          or (${table.status} = 'ENDED')
          or (${table.status} not in ('ACCEPTED', 'ENDED') and ${table.answeredAt} is null)`,
    ),

    check(
      'calls_timestamps_ordered',
      sql`(${table.answeredAt} is null or ${table.answeredAt} >= ${table.startedAt})
          and (${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt})`,
    ),
  ],
);

export const callsRelations = relations(calls, ({ one }) => ({
  order: one(orders, { fields: [calls.orderId], references: [orders.id] }),
}));

export type CallRow = typeof calls.$inferSelect;
export type NewCallRow = typeof calls.$inferInsert;

/**
 * The column types and the wire contracts describe the same sets, in both
 * directions — the guard `orders.ts` puts on `order_status`.
 */
type AssertNever<T extends never> = T;

export type CallStatusEnumHasNoStrangers = AssertNever<
  Exclude<(typeof callStatus.enumValues)[number], CallStatus>
>;
export type CallStatusEnumIsComplete = AssertNever<
  Exclude<CallStatus, (typeof callStatus.enumValues)[number]>
>;
export type CallEndReasonEnumHasNoStrangers = AssertNever<
  Exclude<(typeof callEndReason.enumValues)[number], CallEndReason>
>;
export type CallEndReasonEnumIsComplete = AssertNever<
  Exclude<CallEndReason, (typeof callEndReason.enumValues)[number]>
>;
export type CallPartyKindEnumHasNoStrangers = AssertNever<
  Exclude<(typeof callPartyKind.enumValues)[number], CallPartyKind>
>;
export type CallPartyKindEnumIsComplete = AssertNever<
  Exclude<CallPartyKind, (typeof callPartyKind.enumValues)[number]>
>;
