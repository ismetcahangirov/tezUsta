-- Issue #330, ADR-0053: a party's report about the other party on one order,
-- one per side per order and master, and the admin queue's lifecycle (open,
-- in review, closed) held by a CHECK.
CREATE TYPE "public"."report_outcome" AS ENUM('no_action', 'warning_recorded', 'master_suspended', 'customer_suspended');--> statement-breakpoint
CREATE TYPE "public"."report_party_role" AS ENUM('customer', 'master');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('no_show', 'rude_or_abusive', 'unsafe_behaviour', 'asked_off_platform_payment', 'damage', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'in_review', 'closed');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"master_id" uuid NOT NULL,
	"reporter_role" "report_party_role" NOT NULL,
	"reason_code" "report_reason" NOT NULL,
	"text" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"outcome" "report_outcome",
	"outcome_reason" text,
	"handled_by_admin_id" uuid,
	"claimed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_text_length" CHECK ("reports"."text" is null or length(btrim("reports"."text")) between 1 and 1000),
	CONSTRAINT "reports_outcome_reason_length" CHECK ("reports"."outcome_reason" is null or length(btrim("reports"."outcome_reason")) between 1 and 600),
	CONSTRAINT "reports_status_shape" CHECK (case "reports"."status"
            when 'open' then "reports"."handled_by_admin_id" is null and "reports"."outcome" is null and "reports"."closed_at" is null
            when 'in_review' then "reports"."handled_by_admin_id" is not null and "reports"."claimed_at" is not null and "reports"."outcome" is null and "reports"."closed_at" is null
            else "reports"."handled_by_admin_id" is not null and "reports"."outcome" is not null and "reports"."outcome_reason" is not null and "reports"."closed_at" is not null
          end)
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_admin_id_admin_users_id_fk" FOREIGN KEY ("handled_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_order_pairing_unique" ON "reports" USING btree ("order_id","master_id","reporter_role");--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "reports_master_created_idx" ON "reports" USING btree ("master_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_customer_created_idx" ON "reports" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_handled_by_idx" ON "reports" USING btree ("handled_by_admin_id") WHERE "reports"."handled_by_admin_id" is not null;