CREATE TYPE "public"."subscription_billing_period" AS ENUM('monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."subscription_event_kind" AS ENUM('trial_started', 'period_activated', 'period_queued', 'period_granted', 'queued_period_started', 'cancelled', 'grace_entered', 'expired');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "master_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"billing_period" "subscription_billing_period",
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"grace_ends_at" timestamp with time zone,
	"next_billing_period" "subscription_billing_period",
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_subscriptions_period_order" CHECK ("master_subscriptions"."current_period_end" >= "master_subscriptions"."current_period_start"),
	CONSTRAINT "master_subscriptions_trial_has_no_billing_period" CHECK ("master_subscriptions"."status" <> 'trialing' or "master_subscriptions"."billing_period" is null),
	CONSTRAINT "master_subscriptions_past_due_has_grace" CHECK ("master_subscriptions"."status" <> 'past_due' or "master_subscriptions"."grace_ends_at" is not null),
	CONSTRAINT "master_subscriptions_cancelled_has_timestamp" CHECK ("master_subscriptions"."status" <> 'cancelled' or "master_subscriptions"."cancelled_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_subscription_id" uuid NOT NULL,
	"kind" "subscription_event_kind" NOT NULL,
	"from_status" "subscription_status",
	"to_status" "subscription_status" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"billing_period" "subscription_billing_period",
	"price_id" uuid,
	"amount_minor" bigint,
	"payment_ref" text,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_events_actor_shape" CHECK ("subscription_events"."actor" in ('system', 'provider') or "subscription_events"."actor" ~ '^admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "subscription_events_payment_shape" CHECK (("subscription_events"."price_id" is null) = ("subscription_events"."amount_minor" is null)
          and ("subscription_events"."price_id" is null) = ("subscription_events"."payment_ref" is null)),
	CONSTRAINT "subscription_events_payment_ref_length" CHECK ("subscription_events"."payment_ref" is null or length("subscription_events"."payment_ref") between 1 and 200),
	CONSTRAINT "subscription_events_reason_length" CHECK ("subscription_events"."reason" is null or length(btrim("subscription_events"."reason")) between 1 and 600),
	CONSTRAINT "subscription_events_period_order" CHECK ("subscription_events"."period_end" >= "subscription_events"."period_start")
);
--> statement-breakpoint
CREATE TABLE "subscription_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"billing_period" "subscription_billing_period" NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" text DEFAULT 'AZN' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_prices_price_positive" CHECK ("subscription_prices"."price_minor" > 0),
	CONSTRAINT "subscription_prices_currency_azn" CHECK ("subscription_prices"."currency" = 'AZN')
);
--> statement-breakpoint
CREATE TABLE "subscription_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"trial_days" integer NOT NULL,
	"grace_days" integer NOT NULL,
	"purchases_open" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "subscription_settings_single_row" CHECK ("subscription_settings"."id" = 1),
	CONSTRAINT "subscription_settings_trial_days_range" CHECK ("subscription_settings"."trial_days" between 0 and 90),
	CONSTRAINT "subscription_settings_grace_days_range" CHECK ("subscription_settings"."grace_days" between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "master_subscriptions" ADD CONSTRAINT "master_subscriptions_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_master_subscription_id_master_subscriptions_id_fk" FOREIGN KEY ("master_subscription_id") REFERENCES "public"."master_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_price_id_subscription_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."subscription_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_settings" ADD CONSTRAINT "subscription_settings_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_subscriptions_master_unique" ON "master_subscriptions" USING btree ("master_id");--> statement-breakpoint
CREATE INDEX "master_subscriptions_period_end_due_idx" ON "master_subscriptions" USING btree ("current_period_end") WHERE "master_subscriptions"."status" <> 'expired';--> statement-breakpoint
CREATE INDEX "master_subscriptions_grace_end_due_idx" ON "master_subscriptions" USING btree ("grace_ends_at") WHERE "master_subscriptions"."status" <> 'expired' and "master_subscriptions"."grace_ends_at" is not null;--> statement-breakpoint
CREATE INDEX "subscription_events_subscription_idx" ON "subscription_events" USING btree ("master_subscription_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_events_payment_ref_unique" ON "subscription_events" USING btree ("payment_ref") WHERE "subscription_events"."payment_ref" is not null;--> statement-breakpoint
CREATE INDEX "subscription_events_price_idx" ON "subscription_events" USING btree ("price_id") WHERE "subscription_events"."price_id" is not null;--> statement-breakpoint
CREATE INDEX "subscription_prices_period_effective_idx" ON "subscription_prices" USING btree ("billing_period","effective_from" desc);--> statement-breakpoint
CREATE INDEX "subscription_prices_created_by_admin_idx" ON "subscription_prices" USING btree ("created_by_admin_id");--> statement-breakpoint
CREATE INDEX "subscription_settings_updated_by_admin_idx" ON "subscription_settings" USING btree ("updated_by_admin_id");--> statement-breakpoint
-- Hand-written below this line (issue #322). Drizzle generates neither
-- triggers nor rows.
--
-- `subscription_prices` and `subscription_events` are append-only, enforced
-- here rather than by convention, the same choice `admin_audit_log` made in
-- 0009: a price edited in place rewrites what every earlier payment says it
-- cost, and an editable event history is not a history. Row-level triggers for
-- UPDATE and DELETE, a statement-level one for TRUNCATE, which bypasses them.
CREATE FUNCTION subscription_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER subscription_prices_append_only
  BEFORE UPDATE OR DELETE ON subscription_prices
  FOR EACH ROW EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER subscription_prices_no_truncate
  BEFORE TRUNCATE ON subscription_prices
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER subscription_events_append_only
  BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER subscription_events_no_truncate
  BEFORE TRUNCATE ON subscription_events
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_history_is_append_only();--> statement-breakpoint
-- The settings row may be edited (#324) but never removed: every trial start
-- and every lapse reads it, and "no row" is not a setting.
CREATE FUNCTION subscription_settings_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'subscription_settings cannot be removed: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER subscription_settings_no_delete
  BEFORE DELETE ON subscription_settings
  FOR EACH ROW EXECUTE FUNCTION subscription_settings_is_permanent();--> statement-breakpoint
CREATE TRIGGER subscription_settings_no_truncate
  BEFORE TRUNCATE ON subscription_settings
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_settings_is_permanent();--> statement-breakpoint
-- The one settings row. Trial 14 days and grace 3 days are the owner's launch
-- values (11 October 2026). Purchases stay closed until the owner gives
-- launch prices (ADR-0046 § 5); #324 opens them.
INSERT INTO subscription_settings (id, trial_days, grace_days, purchases_open)
VALUES (1, 14, 3, false);--> statement-breakpoint
-- A master approved before this migration has no subscription, and the
-- dispatch gate would stop offering them work the moment it deploys. They get
-- the trial a master approved today would get, starting now, with the event
-- row every transition leaves. Nothing real is affected — no production master
-- exists while sign-in waits for an SMS provider — but a staging or dev
-- database keeps working.
WITH settings AS (
  SELECT trial_days FROM subscription_settings WHERE id = 1
), started AS (
  INSERT INTO master_subscriptions (id, master_id, status, current_period_start, current_period_end)
  SELECT gen_random_uuid(), m.id, 'trialing', now(), now() + make_interval(days => s.trial_days)
    FROM masters m CROSS JOIN settings s
   WHERE m.verification_status = 'active'
     AND m.deleted_at IS NULL
  RETURNING id, current_period_start, current_period_end
)
INSERT INTO subscription_events
  (id, master_subscription_id, kind, from_status, to_status, period_start, period_end, actor, reason)
SELECT gen_random_uuid(), id, 'trial_started', NULL, 'trialing', current_period_start,
       current_period_end, 'system', 'Trial for a master approved before subscriptions existed.'
  FROM started;
