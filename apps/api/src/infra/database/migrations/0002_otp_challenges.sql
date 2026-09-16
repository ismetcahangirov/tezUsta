CREATE TYPE "public"."otp_invalidation_reason" AS ENUM('superseded', 'attempts_exhausted');--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" "otp_invalidation_reason"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "otp_challenges_live_per_phone_unique" ON "otp_challenges" USING btree ("phone_e164") WHERE "otp_challenges"."consumed_at" is null and "otp_challenges"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges" USING btree ("expires_at");