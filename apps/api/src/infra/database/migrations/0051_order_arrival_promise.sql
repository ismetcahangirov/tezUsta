CREATE TYPE "public"."arrival_promise_source" AS ENUM('route', 'estimate');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promised_arrival_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "arrival_promise_source" "arrival_promise_source";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_arrival_promise_shape" CHECK (("orders"."promised_arrival_at" is null) = ("orders"."arrival_promise_source" is null)
          and ("orders"."promised_arrival_at" is null or "orders"."accepted_at" is not null));