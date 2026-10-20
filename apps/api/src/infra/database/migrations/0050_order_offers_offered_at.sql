ALTER TABLE "order_offers" ADD COLUMN "offered_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-written (#397): every existing row was last offered no earlier than it was
-- created, and the row does not record a later re-offer, so `created_at` is the
-- one honest value. Only an order searching during the deploy can be affected,
-- and only by under-counting a master its current search re-offered before the
-- new code started writing this column; the next re-offer corrects it.
UPDATE "order_offers" SET "offered_at" = "created_at";
