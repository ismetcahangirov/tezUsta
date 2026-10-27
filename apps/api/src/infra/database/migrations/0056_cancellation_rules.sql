CREATE TYPE "public"."order_cancellation_kind" AS ENUM('free', 'late', 'master_late', 'price_declined');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_kind" "order_cancellation_kind";--> statement-breakpoint
-- Edited by hand (ADR-0068, #461): a quote already declined is classed as
-- one before the CHECK below requires it. Every other cancellation from
-- before ADR-0068 stays unclassed: it was made under no rule.
UPDATE "orders" SET "cancellation_kind" = 'price_declined' WHERE "price_declined_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancellation_kind_shape" CHECK (("orders"."cancellation_kind" is null or "orders"."status" = 'CANCELLED')
          and (("orders"."price_declined_at" is not null)
               = ("orders"."cancellation_kind" is not distinct from 'price_declined')));
