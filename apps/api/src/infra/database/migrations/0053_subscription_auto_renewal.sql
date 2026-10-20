CREATE TYPE "public"."subscription_checkout_kind" AS ENUM('hosted', 'renewal');--> statement-breakpoint
CREATE TYPE "public"."subscription_payment_method_revoked_reason" AS ENUM('master', 'replaced');--> statement-breakpoint
CREATE TABLE "subscription_payment_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"token_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "subscription_payment_method_revoked_reason",
	CONSTRAINT "subscription_payment_methods_provider_shape" CHECK ("subscription_payment_methods"."provider" ~ '^[a-z][a-z0-9-]{0,31}$'),
	CONSTRAINT "subscription_payment_methods_token_ref_length" CHECK (length("subscription_payment_methods"."token_ref") between 1 and 512),
	CONSTRAINT "subscription_payment_methods_revoked_shape" CHECK (("subscription_payment_methods"."revoked_at" is null) = ("subscription_payment_methods"."revoked_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "subscription_checkouts" DROP CONSTRAINT "subscription_checkouts_checkout_url_shape";--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ALTER COLUMN "checkout_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD COLUMN "kind" "subscription_checkout_kind" DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD COLUMN "save_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD COLUMN "renews_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "subscription_payment_methods" ADD CONSTRAINT "subscription_payment_methods_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payment_methods_one_live" ON "subscription_payment_methods" USING btree ("master_id") WHERE "subscription_payment_methods"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "subscription_payment_methods_master_idx" ON "subscription_payment_methods" USING btree ("master_id");--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_payment_method_id_subscription_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."subscription_payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkouts_one_renewal_per_period" ON "subscription_checkouts" USING btree ("master_id","renews_period_end") WHERE "subscription_checkouts"."kind" = 'renewal';--> statement-breakpoint
CREATE INDEX "subscription_checkouts_payment_method_idx" ON "subscription_checkouts" USING btree ("payment_method_id") WHERE "subscription_checkouts"."payment_method_id" is not null;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_kind_shape" CHECK (case "subscription_checkouts"."kind"
            when 'hosted' then "subscription_checkouts"."checkout_url" is not null
                           and "subscription_checkouts"."renews_period_end" is null
                           and "subscription_checkouts"."payment_method_id" is null
            else "subscription_checkouts"."checkout_url" is null
                 and not "subscription_checkouts"."save_card"
                 and "subscription_checkouts"."renews_period_end" is not null
                 and "subscription_checkouts"."payment_method_id" is not null
          end);--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_checkout_url_shape" CHECK ("subscription_checkouts"."checkout_url" is null
          or ("subscription_checkouts"."checkout_url" ~ '^https://' and length("subscription_checkouts"."checkout_url") <= 2048));--> statement-breakpoint
-- Hand-written below this line (issue #323). Drizzle generates no triggers.
--
-- A saved card is never deleted (renewal checkouts point at it), and the only
-- change it ever takes is being revoked, once: every other column, and a
-- revoked row, stay as they were written.
CREATE FUNCTION subscription_payment_method_only_revokes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
     OR OLD.revoked_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.master_id IS DISTINCT FROM OLD.master_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.token_ref IS DISTINCT FROM OLD.token_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'subscription_payment_methods rows are only ever revoked: % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER subscription_payment_methods_only_revokes
  BEFORE UPDATE OR DELETE ON subscription_payment_methods
  FOR EACH ROW EXECUTE FUNCTION subscription_payment_method_only_revokes();--> statement-breakpoint
CREATE TRIGGER subscription_payment_methods_no_truncate
  BEFORE TRUNCATE ON subscription_payment_methods
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_history_is_append_only();
