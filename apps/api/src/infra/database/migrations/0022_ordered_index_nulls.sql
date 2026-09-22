-- Issue #191 — every ordered index rebuilt so it can serve its ORDER BY.
--
-- Drizzle's `.desc()` emits `DESC NULLS LAST`; a bare `ORDER BY x DESC` means
-- `DESC NULLS FIRST`. The planner compares the ordering specifications rather
-- than what the data can contain, so a NOT NULL column does not bridge the gap:
-- the index served the filter and Postgres sorted the matching rows anyway.
-- Measured on a 5 000-row scratch table, Postgres 17, `enable_seqscan` and
-- `enable_bitmapscan` off, `where owner = $1 order by created_at desc, id desc
-- limit 30`:
--
--   (owner, created_at desc nulls last, id desc nulls last)  Index Only Scan + Sort
--   (owner, created_at desc,            id desc)             Index Only Scan, no Sort
--   (owner, created_at desc)                                 Index Scan + Incremental Sort
--
-- The third line is why `admin_audit_log_target_idx`,
-- `admin_audit_log_actor_idx`, `master_verification_history_master_idx` and
-- `master_locations_master_recent_idx` also gain an `id` column: their queries
-- break ties on `id`, and without it the tiebreaker alone costs a sort node.
--
-- The alternative fix — spelling `NULLS LAST` into every ORDER BY, which
-- `orders.repository.ts` did after #82 — is reverted in the same commit. It
-- works and it makes the idiomatic query the wrong one.
--
-- **No CONCURRENTLY, deliberately.** `drizzle-orm`'s migrator runs the whole
-- pending set inside a single transaction — verified in the shipped package,
-- `pg-core/dialect.js`, `PgDialect.migrate`: `session.transaction()` wraps the
-- loop over every migration file. `CREATE INDEX CONCURRENTLY` cannot run in a
-- transaction block, so it is not something this file can opt into; it would
-- need a transactionless runner that does not exist. Nothing is deployed yet
-- (EPIC 17, hosting undecided), so every table this touches is empty or small
-- in every environment that exists, and the DROP/CREATE pair below holds an
-- ACCESS EXCLUSIVE lock only for as long as the rebuild takes. The first
-- environment with real data changes that answer: `master_locations` is the
-- table that grows without bound, and re-running this shape against a live one
-- means CONCURRENTLY in a transactionless migration, not this file.

DROP INDEX "addresses_customer_live_idx";--> statement-breakpoint
DROP INDEX "admin_audit_log_target_idx";--> statement-breakpoint
DROP INDEX "admin_audit_log_actor_idx";--> statement-breakpoint
DROP INDEX "admin_sessions_admin_live_idx";--> statement-breakpoint
DROP INDEX "master_verification_history_master_idx";--> statement-breakpoint
DROP INDEX "order_status_history_actor_admin_idx";--> statement-breakpoint
DROP INDEX "order_status_history_actor_user_idx";--> statement-breakpoint
DROP INDEX "orders_customer_created_idx";--> statement-breakpoint
DROP INDEX "orders_master_created_idx";--> statement-breakpoint
DROP INDEX "master_locations_master_recent_idx";--> statement-breakpoint
DROP INDEX "order_offers_master_status_created_idx";--> statement-breakpoint
CREATE INDEX "addresses_customer_live_idx" ON "addresses" USING btree ("customer_id","is_default" desc,"created_at" desc) WHERE "addresses"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_type","target_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_idx" ON "admin_audit_log" USING btree ("admin_user_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_live_idx" ON "admin_sessions" USING btree ("admin_user_id","expires_at" desc) WHERE "admin_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "master_verification_history_master_idx" ON "master_verification_history" USING btree ("master_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "order_status_history_actor_admin_idx" ON "order_status_history" USING btree ("actor_admin_id","created_at" desc) WHERE "order_status_history"."actor_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "order_status_history_actor_user_idx" ON "order_status_history" USING btree ("actor_user_id","created_at" desc) WHERE "order_status_history"."actor_user_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "orders_master_created_idx" ON "orders" USING btree ("master_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "master_locations_master_recent_idx" ON "master_locations" USING btree ("master_id","recorded_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "order_offers_master_status_created_idx" ON "order_offers" USING btree ("master_id","status","created_at" desc);