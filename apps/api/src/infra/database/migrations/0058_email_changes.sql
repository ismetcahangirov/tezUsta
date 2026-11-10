CREATE TYPE "public"."email_change_invalidation_reason" AS ENUM('superseded', 'attempts_exhausted');--> statement-breakpoint
ALTER TYPE "public"."session_revoked_reason" ADD VALUE 'email_change';--> statement-breakpoint
CREATE TABLE "email_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"old_email" text NOT NULL,
	"new_email" text NOT NULL,
	"current_code_hash" text NOT NULL,
	"new_code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" "email_change_invalidation_reason"
);
--> statement-breakpoint
ALTER TABLE "email_changes" ADD CONSTRAINT "email_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_changes_live_per_user_unique" ON "email_changes" USING btree ("user_id") WHERE "email_changes"."completed_at" is null and "email_changes"."invalidated_at" is null;