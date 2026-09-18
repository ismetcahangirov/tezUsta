-- The customer order history index gains `id` as a third column.
--
-- `(customer_id, created_at DESC)` serves the filter but not the order: the
-- keyset cursor `GET /orders` pages by is `(created_at, id)`, so without `id`
-- Postgres fetches every row older than the cursor and top-N sorts it, and the
-- cost of page five grows with how long the customer has been a customer.
--
-- Plain DROP/CREATE rather than CREATE INDEX CONCURRENTLY: `orders` is created
-- by the migration immediately before this one and has never held a row in any
-- deployed environment, so there is no table here to lock. The day this index
-- is changed again on a populated table, that change is CONCURRENTLY.
DROP INDEX "orders_customer_created_idx";--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);