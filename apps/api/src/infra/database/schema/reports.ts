import { sql } from 'drizzle-orm';
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

import { adminUsers } from './admin';
import { customers } from './customers';
import { masters } from './masters';
import { orders } from './orders';

/** ADR-0053 § 2: a closed list, so the queue can be filtered and counted. */
export const reportReason = pgEnum('report_reason', [
  'no_show',
  'rude_or_abusive',
  'unsafe_behaviour',
  'asked_off_platform_payment',
  'damage',
  'other',
]);

export const reportStatus = pgEnum('report_status', ['open', 'in_review', 'closed']);

/**
 * How an admin closed a report. A suspension outcome records an action taken
 * on the reported party's own page; closing a report suspends nobody.
 */
export const reportOutcome = pgEnum('report_outcome', [
  'no_action',
  'warning_recorded',
  'master_suspended',
  'customer_suspended',
]);

export const reportPartyRole = pgEnum('report_party_role', ['customer', 'master']);

/**
 * A party's report about the other party on one order (#330, ADR-0053).
 *
 * The two parties are stored as **profiles**, with the reporter's side: the
 * reported party is the other one. Profiles rather than user ids, because the
 * admin queue links to a customer's or a master's page and counts reports per
 * subject, and one account holding both roles is two subjects. No composite
 * key to the order's parties, as `reviews` has: a report can be filed while
 * the order is live, and a re-dispatch changes the order's master under it.
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    /** Who filed it. The reported party is the other side. */
    reporterRole: reportPartyRole('reporter_role').notNull(),

    reasonCode: reportReason('reason_code').notNull(),

    /** The reporter's words. Never shown to the reported party; text only in the panel. */
    text: text('text'),

    status: reportStatus('status').notNull().default('open'),

    outcome: reportOutcome('outcome'),
    outcomeReason: text('outcome_reason'),

    handledByAdminId: uuid('handled_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * One report per side per order **and master** (ADR-0053 § 3): after a
     * re-dispatch the new master is a new pairing, with its own report on
     * each side, and never reaches the previous master's.
     */
    uniqueIndex('reports_order_pairing_unique').on(
      table.orderId,
      table.masterId,
      table.reporterRole,
    ),

    /** The queue: oldest first within a status. */
    index('reports_queue_idx').on(table.status, table.createdAt, table.id),

    /** Reports about one master, and about one customer, by time — the repeat-offender count. */
    index('reports_master_created_idx').on(table.masterId, table.createdAt),
    index('reports_customer_created_idx').on(table.customerId, table.createdAt),

    index('reports_handled_by_idx')
      .on(table.handledByAdminId)
      .where(sql`${table.handledByAdminId} is not null`),

    check(
      'reports_text_length',
      sql`${table.text} is null or length(btrim(${table.text})) between 1 and 1000`,
    ),
    check(
      'reports_outcome_reason_length',
      sql`${table.outcomeReason} is null or length(btrim(${table.outcomeReason})) between 1 and 600`,
    ),
    /**
     * The lifecycle, held by the database rather than by the one service that
     * writes it: open has no handler and no outcome; in review has a handler;
     * closed has a handler, an outcome, its reason and its time.
     */
    check(
      'reports_status_shape',
      sql`case ${table.status}
            when 'open' then ${table.handledByAdminId} is null and ${table.outcome} is null and ${table.closedAt} is null
            when 'in_review' then ${table.handledByAdminId} is not null and ${table.claimedAt} is not null and ${table.outcome} is null and ${table.closedAt} is null
            else ${table.handledByAdminId} is not null and ${table.outcome} is not null and ${table.outcomeReason} is not null and ${table.closedAt} is not null
          end`,
    ),
  ],
);

export type ReportRow = typeof reports.$inferSelect;
export type ReportReasonName = (typeof reportReason.enumValues)[number];
export type ReportStatusName = (typeof reportStatus.enumValues)[number];
export type ReportOutcomeName = (typeof reportOutcome.enumValues)[number];
export type ReportPartyRoleName = (typeof reportPartyRole.enumValues)[number];
