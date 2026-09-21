CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."device_revoked_reason" AS ENUM('unregistered');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"expo_push_token" varchar(255) NOT NULL,
	"device_id" varchar(128),
	"app_version" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "device_revoked_reason",
	CONSTRAINT "devices_revocation_shape" CHECK (("devices"."revoked_at" is null) = ("devices"."revoked_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_expo_push_token_unique" ON "devices" USING btree ("expo_push_token");--> statement-breakpoint
CREATE INDEX "devices_user_id_live_idx" ON "devices" USING btree ("user_id") WHERE "devices"."revoked_at" is null;