CREATE TYPE "public"."account_recovery_cancel_source" AS ENUM('admin', 'link', 'code_attempts', 'stale');--> statement-breakpoint
CREATE TABLE "account_recovery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"old_email" text NOT NULL,
	"new_email" text NOT NULL,
	"opened_by_admin_id" uuid NOT NULL,
	"evidence_notes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code_hash" text NOT NULL,
	"code_expires_at" timestamp with time zone NOT NULL,
	"code_verified_at" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"cancel_token_hash" text,
	"cancelled_at" timestamp with time zone,
	"cancel_source" "account_recovery_cancel_source",
	"cancelled_by_admin_id" uuid,
	"cancel_reason" text,
	"approved_by_admin_id" uuid,
	"approve_reason" text,
	"moved_at" timestamp with time zone,
	CONSTRAINT "account_recovery_requests_hold_with_verification" CHECK (("account_recovery_requests"."code_verified_at" is null) = ("account_recovery_requests"."hold_until" is null)
          and ("account_recovery_requests"."code_verified_at" is null) = ("account_recovery_requests"."cancel_token_hash" is null)),
	CONSTRAINT "account_recovery_requests_two_admins" CHECK ("account_recovery_requests"."approved_by_admin_id" is null or "account_recovery_requests"."approved_by_admin_id" <> "account_recovery_requests"."opened_by_admin_id"),
	CONSTRAINT "account_recovery_requests_move_shape" CHECK ("account_recovery_requests"."moved_at" is null
          or ("account_recovery_requests"."approved_by_admin_id" is not null and "account_recovery_requests"."code_verified_at" is not null
              and "account_recovery_requests"."cancelled_at" is null)),
	CONSTRAINT "account_recovery_requests_cancel_shape" CHECK (("account_recovery_requests"."cancelled_at" is null) = ("account_recovery_requests"."cancel_source" is null)
          and ("account_recovery_requests"."cancelled_by_admin_id" is null or "account_recovery_requests"."cancel_source" = 'admin')),
	CONSTRAINT "account_recovery_requests_text_bounds" CHECK (char_length("account_recovery_requests"."evidence_notes") between 1 and 4000
          and ("account_recovery_requests"."cancel_reason" is null or char_length("account_recovery_requests"."cancel_reason") <= 600)
          and ("account_recovery_requests"."approve_reason" is null or char_length("account_recovery_requests"."approve_reason") <= 600))
);
--> statement-breakpoint
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_opened_by_admin_id_admin_users_id_fk" FOREIGN KEY ("opened_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_cancelled_by_admin_id_admin_users_id_fk" FOREIGN KEY ("cancelled_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_approved_by_admin_id_admin_users_id_fk" FOREIGN KEY ("approved_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_recovery_requests_open_per_user_unique" ON "account_recovery_requests" USING btree ("user_id") WHERE "account_recovery_requests"."cancelled_at" is null and "account_recovery_requests"."moved_at" is null;--> statement-breakpoint
CREATE INDEX "account_recovery_requests_user_idx" ON "account_recovery_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_recovery_requests_cancel_token_unique" ON "account_recovery_requests" USING btree ("cancel_token_hash");--> statement-breakpoint
CREATE INDEX "account_recovery_requests_opened_by_idx" ON "account_recovery_requests" USING btree ("opened_by_admin_id");--> statement-breakpoint
CREATE INDEX "account_recovery_requests_approved_by_idx" ON "account_recovery_requests" USING btree ("approved_by_admin_id");--> statement-breakpoint
CREATE INDEX "account_recovery_requests_cancelled_by_idx" ON "account_recovery_requests" USING btree ("cancelled_by_admin_id");