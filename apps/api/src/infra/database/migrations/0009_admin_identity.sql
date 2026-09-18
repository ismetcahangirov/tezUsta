CREATE TYPE "public"."admin_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_log_action_shape" CHECK ("admin_audit_log"."action" ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$' and length("admin_audit_log"."action") <= 64),
	CONSTRAINT "admin_audit_log_target_type_shape" CHECK ("admin_audit_log"."target_type" ~ '^[a-z][a-z0-9_]*$' and length("admin_audit_log"."target_type") <= 32),
	CONSTRAINT "admin_audit_log_reason_length" CHECK ("admin_audit_log"."reason" is null or length(btrim("admin_audit_log"."reason")) between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "admin_user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "admin_users_email_lowercase" CHECK ("admin_users"."email" = lower("admin_users"."email")),
	CONSTRAINT "admin_users_email_shape" CHECK (length("admin_users"."email") between 3 and 320 and position('@' in "admin_users"."email") > 1),
	CONSTRAINT "admin_users_display_name_length" CHECK (length(btrim("admin_users"."display_name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "master_verification_history" DROP CONSTRAINT "master_verification_history_actor_shape";--> statement-breakpoint
ALTER TABLE "master_documents" ADD COLUMN "reviewed_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "master_documents" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "master_verification_history" ADD COLUMN "actor_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_idx" ON "admin_audit_log" USING btree ("admin_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_live_idx" ON "admin_sessions" USING btree ("admin_user_id","expires_at" DESC NULLS LAST) WHERE "admin_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_live_unique" ON "admin_users" USING btree ("email") WHERE "admin_users"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "master_documents" ADD CONSTRAINT "master_documents_reviewed_by_admin_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_verification_history" ADD CONSTRAINT "master_verification_history_actor_admin_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_documents" ADD CONSTRAINT "master_documents_review_shape" CHECK (("master_documents"."status" in ('accepted', 'rejected'))
          = ("master_documents"."reviewed_by_admin_id" is not null and "master_documents"."reviewed_at" is not null));--> statement-breakpoint
ALTER TABLE "master_verification_history" ADD CONSTRAINT "master_verification_history_actor_shape" CHECK (("master_verification_history"."actor_kind" = 'master') = ("master_verification_history"."actor_user_id" is not null)
          and ("master_verification_history"."actor_kind" = 'admin') = ("master_verification_history"."actor_admin_id" is not null));--> statement-breakpoint
-- Hand-written, for the reason `0008_master_verification.sql` gives: an audit
-- trail the application merely promises not to rewrite has integrity that
-- depends on every future query being careful. `docs/product/admin-flow.md`
-- is blunt about the stakes — "an unlogged admin action is indistinguishable
-- from an attacker's" — and a *rewritable* one is worse than unlogged, because
-- it looks like evidence.
--
-- Two triggers: row-level for UPDATE and DELETE, statement-level for TRUNCATE,
-- which bypasses row-level triggers entirely.
CREATE FUNCTION admin_audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_audit_log_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_is_append_only();--> statement-breakpoint
CREATE TRIGGER admin_audit_log_no_truncate
  BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_log_is_append_only();
