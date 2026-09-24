CREATE TYPE "public"."call_end_reason" AS ENUM('declined', 'cancelled', 'no_answer', 'busy', 'hangup', 'order_closed', 'room_gone', 'reaped');--> statement-breakpoint
CREATE TYPE "public"."call_party_kind" AS ENUM('customer', 'master');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('RINGING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'TIMED_OUT', 'BUSY', 'ENDED');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"caller_kind" "call_party_kind" NOT NULL,
	"caller_id" uuid NOT NULL,
	"caller_user_id" uuid NOT NULL,
	"callee_kind" "call_party_kind" NOT NULL,
	"callee_id" uuid NOT NULL,
	"callee_user_id" uuid NOT NULL,
	"status" "call_status" NOT NULL,
	"room_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" "call_end_reason",
	CONSTRAINT "calls_room_name_derived" CHECK ("calls"."room_name" = 'call-' || "calls"."id"::text),
	CONSTRAINT "calls_parties_differ" CHECK ("calls"."caller_kind" <> "calls"."callee_kind"),
	CONSTRAINT "calls_end_matches_status" CHECK (("calls"."status" in ('RINGING', 'ACCEPTED')) = ("calls"."ended_at" is null and "calls"."end_reason" is null)),
	CONSTRAINT "calls_answer_matches_status" CHECK (("calls"."status" = 'ACCEPTED' and "calls"."answered_at" is not null)
          or ("calls"."status" = 'ENDED')
          or ("calls"."status" not in ('ACCEPTED', 'ENDED') and "calls"."answered_at" is null)),
	CONSTRAINT "calls_timestamps_ordered" CHECK (("calls"."answered_at" is null or "calls"."answered_at" >= "calls"."started_at")
          and ("calls"."ended_at" is null or "calls"."ended_at" >= "calls"."started_at"))
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_user_id_users_id_fk" FOREIGN KEY ("caller_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_user_id_users_id_fk" FOREIGN KEY ("callee_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_one_live_per_order" ON "calls" USING btree ("order_id") WHERE "calls"."status" in ('RINGING', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "calls_live_caller_user_idx" ON "calls" USING btree ("caller_user_id") WHERE "calls"."status" in ('RINGING', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "calls_live_callee_user_idx" ON "calls" USING btree ("callee_user_id") WHERE "calls"."status" in ('RINGING', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "calls_caller_user_idx" ON "calls" USING btree ("caller_user_id");--> statement-breakpoint
CREATE INDEX "calls_callee_user_idx" ON "calls" USING btree ("callee_user_id");--> statement-breakpoint
CREATE INDEX "calls_order_started_idx" ON "calls" USING btree ("order_id","started_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "calls_room_name_unique" ON "calls" USING btree ("room_name");