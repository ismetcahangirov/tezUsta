import { relations } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { devices } from './devices';

/**
 * One row per push Expo accepted but has not yet reported the outcome of.
 *
 * **This table exists because Expo's push API is two-phase.** `/send` answers
 * with a *ticket* meaning "accepted for delivery"; the real outcome only
 * appears at the receipts endpoint minutes later. A token belonging to an app
 * that has been uninstalled passes phase one cleanly and fails phase two, so
 * "prune the tokens that are dead" is unimplementable inside the send path —
 * it needs somewhere to write down what to ask about. That is this.
 *
 * It is deliberately a **worklist rather than a log**: a row means "this
 * receipt still needs checking". Issue #142 asks Expo about them and deletes
 * the rows it resolves, plus anything past Expo's availability window — the
 * shipped SDK's own words are that receipts "will be available for a period of
 * time (approximately a day)". Keeping resolved rows would turn a bounded
 * worklist into an unbounded delivery log nobody reads, and the delivery
 * record that does matter is the device's own `revoked_at`.
 *
 * There is no `updated_at`: a row is written once and deleted, never changed.
 */
export const pushTickets = pgTable(
  'push_tickets',
  {
    id: uuid('id').primaryKey(),

    /**
     * `restrict` rather than `cascade`, following the rule in
     * `docs/architecture/database-architecture.md` § Integrity rules. A device
     * is retired rather than deleted, so this never fires in practice — and if
     * somebody ever does delete one, failing loudly beats silently discarding
     * the receipts that would have explained why it went quiet.
     */
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'restrict' }),

    /**
     * Expo's receipt id, as handed back by the send.
     *
     * Unique, because a receipt id names one attempted delivery and asking
     * about it twice is work Expo does not owe us. It is also what makes the
     * write idempotent under a job retry that re-sent nothing.
     */
    receiptId: varchar('receipt_id', { length: 255 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('push_tickets_receipt_id_unique').on(table.receiptId),

    /**
     * The sweep's predicate is "old enough that Expo will have an answer",
     * which names only the timestamp — so the foreign-key index below cannot
     * serve it, exactly as `master_locations_retention_idx` could not serve a
     * predicate naming only `recorded_at`.
     */
    index('push_tickets_created_at_idx').on(table.createdAt),

    /** Every foreign key gets an index; Postgres does not create one. */
    index('push_tickets_device_id_idx').on(table.deviceId),
  ],
);

export const pushTicketsRelations = relations(pushTickets, ({ one }) => ({
  device: one(devices, {
    fields: [pushTickets.deviceId],
    references: [devices.id],
  }),
}));

export type PushTicketRow = typeof pushTickets.$inferSelect;
export type NewPushTicketRow = typeof pushTickets.$inferInsert;
