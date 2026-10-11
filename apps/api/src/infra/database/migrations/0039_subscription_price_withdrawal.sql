-- Issue #324: a scheduled subscription price can be withdrawn before it takes
-- effect. The table stays append-only, so a withdrawal is a row of its own
-- (withdraws_price_id set, no price), and the current-price read skips both
-- the withdrawal row and the version it withdrew.
ALTER TABLE "subscription_prices" DROP CONSTRAINT "subscription_prices_price_positive";--> statement-breakpoint
DROP INDEX "subscription_prices_period_effective_idx";--> statement-breakpoint
ALTER TABLE "subscription_prices" ALTER COLUMN "price_minor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_prices" ADD COLUMN "withdraws_price_id" uuid;--> statement-breakpoint
ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_withdraws_price_id_subscription_prices_id_fk" FOREIGN KEY ("withdraws_price_id") REFERENCES "public"."subscription_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_prices_withdraws_unique" ON "subscription_prices" USING btree ("withdraws_price_id") WHERE "subscription_prices"."withdraws_price_id" is not null;--> statement-breakpoint
CREATE INDEX "subscription_prices_period_effective_idx" ON "subscription_prices" USING btree ("billing_period","effective_from" desc,"created_at" desc);--> statement-breakpoint
ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_withdrawal_shape" CHECK (("subscription_prices"."withdraws_price_id" is null) = ("subscription_prices"."price_minor" is not null));--> statement-breakpoint
ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_price_positive" CHECK ("subscription_prices"."price_minor" is null or "subscription_prices"."price_minor" > 0);