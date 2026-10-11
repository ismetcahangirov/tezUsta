-- Issue #326: subscription pushes. A new notification category for them, the
-- ledger that makes each push go out once — a row per (subscription, kind,
-- period end or price version), claimed before the push is raised — and the
-- index the price-change notice reads masters by their renewal period from.
CREATE TYPE "public"."subscription_notice_kind" AS ENUM('ending', 'grace', 'expired', 'renewed', 'price_change');--> statement-breakpoint
ALTER TYPE "public"."notification_category" ADD VALUE 'subscription';--> statement-breakpoint
CREATE TABLE "subscription_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_subscription_id" uuid NOT NULL,
	"kind" "subscription_notice_kind" NOT NULL,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_notices_dedup_key_length" CHECK (length("subscription_notices"."dedup_key") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "subscription_notices" ADD CONSTRAINT "subscription_notices_master_subscription_id_master_subscriptions_id_fk" FOREIGN KEY ("master_subscription_id") REFERENCES "public"."master_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_notices_once" ON "subscription_notices" USING btree ("master_subscription_id","kind","dedup_key");--> statement-breakpoint
CREATE INDEX "master_subscriptions_renewal_period_idx" ON "master_subscriptions" USING btree (coalesce("next_billing_period", "billing_period"),"id") WHERE "master_subscriptions"."status" in ('trialing', 'active', 'past_due');