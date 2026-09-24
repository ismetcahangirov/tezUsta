CREATE TYPE "public"."admin_role" AS ENUM('support', 'moderator', 'finance', 'super_admin');--> statement-breakpoint
CREATE TABLE "admin_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_admin_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invitations_token_hash_shape" CHECK ("admin_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_invitations_spent_once" CHECK ("admin_invitations"."used_at" is null or "admin_invitations"."revoked_at" is null)
);
--> statement-breakpoint
CREATE TABLE "admin_refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_refresh_tokens_token_hash_shape" CHECK ("admin_refresh_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "admin_user_roles" (
	"admin_user_id" uuid NOT NULL,
	"role" "admin_role" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_admin_id" uuid,
	CONSTRAINT "admin_user_roles_pk" PRIMARY KEY("admin_user_id","role")
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN "before" jsonb;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN "after" jsonb;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "last_totp_step" bigint;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "credentials_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_session_id_admin_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."admin_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_granted_by_admin_id_admin_users_id_fk" FOREIGN KEY ("granted_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_invitations_token_hash_unique" ON "admin_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_invitations_admin_live_idx" ON "admin_invitations" USING btree ("admin_user_id") WHERE "admin_invitations"."used_at" is null and "admin_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "admin_invitations_created_by_idx" ON "admin_invitations" USING btree ("created_by_admin_id") WHERE "admin_invitations"."created_by_admin_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_refresh_tokens_token_hash_unique" ON "admin_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_refresh_tokens_session_idx" ON "admin_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "admin_user_roles_role_idx" ON "admin_user_roles" USING btree ("role");--> statement-breakpoint
CREATE INDEX "admin_user_roles_granted_by_idx" ON "admin_user_roles" USING btree ("granted_by_admin_id") WHERE "admin_user_roles"."granted_by_admin_id" is not null;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_totp_enrolment" CHECK (("admin_users"."totp_secret_encrypted" is null) = ("admin_users"."totp_enrolled_at" is null));--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_last_totp_step_needs_enrolment" CHECK ("admin_users"."last_totp_step" is null or "admin_users"."totp_enrolled_at" is not null);