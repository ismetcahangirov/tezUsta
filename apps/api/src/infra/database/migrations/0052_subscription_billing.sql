CREATE TYPE "public"."subscription_payment_disposition" AS ENUM('activated', 'already_applied', 'recorded', 'amount_mismatch', 'unknown_checkout', 'period_already_queued');--> statement-breakpoint
CREATE TYPE "public"."subscription_payment_kind" AS ENUM('succeeded', 'failed', 'refunded');--> statement-breakpoint
ALTER TYPE "public"."subscription_event_kind" ADD VALUE 'payment_failed';--> statement-breakpoint
ALTER TYPE "public"."subscription_event_kind" ADD VALUE 'payment_refunded';--> statement-breakpoint
CREATE TABLE "subscription_checkouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"billing_period" "subscription_billing_period" NOT NULL,
	"price_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"checkout_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_checkouts_amount_positive" CHECK ("subscription_checkouts"."amount_minor" > 0),
	CONSTRAINT "subscription_checkouts_currency_azn" CHECK ("subscription_checkouts"."currency" = 'AZN'),
	CONSTRAINT "subscription_checkouts_provider_shape" CHECK ("subscription_checkouts"."provider" ~ '^[a-z][a-z0-9-]{0,31}$'),
	CONSTRAINT "subscription_checkouts_provider_ref_length" CHECK (length("subscription_checkouts"."provider_ref") between 1 and 160),
	CONSTRAINT "subscription_checkouts_checkout_url_shape" CHECK ("subscription_checkouts"."checkout_url" ~ '^https://' and length("subscription_checkouts"."checkout_url") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_ref" text NOT NULL,
	"checkout_id" uuid,
	"kind" "subscription_payment_kind" NOT NULL,
	"disposition" "subscription_payment_disposition" NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_provider_shape" CHECK ("subscription_payments"."provider" ~ '^[a-z][a-z0-9-]{0,31}$'),
	CONSTRAINT "subscription_payments_event_id_length" CHECK (length("subscription_payments"."provider_event_id") between 1 and 200),
	CONSTRAINT "subscription_payments_provider_ref_length" CHECK (length("subscription_payments"."provider_ref") between 1 and 160),
	CONSTRAINT "subscription_payments_amount_shape" CHECK (("subscription_payments"."amount_minor" is null) = ("subscription_payments"."currency" is null)
          and ("subscription_payments"."amount_minor" is null or "subscription_payments"."amount_minor" >= 0)),
	CONSTRAINT "subscription_payments_currency_shape" CHECK ("subscription_payments"."currency" is null or "subscription_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "subscription_payments_unknown_has_no_checkout" CHECK (("subscription_payments"."disposition" = 'unknown_checkout') = ("subscription_payments"."checkout_id" is null))
);
--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_price_id_subscription_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."subscription_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_checkout_id_subscription_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."subscription_checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkouts_provider_ref_unique" ON "subscription_checkouts" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "subscription_checkouts_master_created_idx" ON "subscription_checkouts" USING btree ("master_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "subscription_checkouts_price_idx" ON "subscription_checkouts" USING btree ("price_id");--> statement-breakpoint
CREATE INDEX "subscription_checkouts_created_idx" ON "subscription_checkouts" USING btree ("created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_event_unique" ON "subscription_payments" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "subscription_payments_provider_ref_idx" ON "subscription_payments" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "subscription_payments_checkout_idx" ON "subscription_payments" USING btree ("checkout_id") WHERE "subscription_payments"."checkout_id" is not null;--> statement-breakpoint
-- Hand-written below this line (issue #323). Drizzle generates no triggers.
--
-- `subscription_checkouts` and `subscription_payments` are append-only, for
-- `subscription_events`' reason (0038): a checkout edited in place rewrites
-- what a master was asked to pay, and a provider event edited in place is no
-- longer what the provider said. The trigger function is 0038's own.
CREATE TRIGGER subscription_checkouts_append_only
  BEFORE UPDATE OR DELETE ON subscription_checkouts
  FOR EACH ROW EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER subscription_checkouts_no_truncate
  BEFORE TRUNCATE ON subscription_checkouts
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER subscription_payments_append_only
  BEFORE UPDATE OR DELETE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER subscription_payments_no_truncate
  BEFORE TRUNCATE ON subscription_payments
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_history_is_append_only();
