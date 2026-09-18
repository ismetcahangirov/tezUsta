CREATE TYPE "public"."master_document_status" AS ENUM('awaiting_upload', 'pending_review', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."master_document_type" AS ENUM('id_card_front', 'id_card_back', 'selfie_with_id');--> statement-breakpoint
CREATE TYPE "public"."master_verification_actor_kind" AS ENUM('master', 'admin', 'system');--> statement-breakpoint
CREATE TABLE "master_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"document_type" "master_document_type" NOT NULL,
	"storage_key" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"verified_content_type" text,
	"size_bytes" integer,
	"status" "master_document_status" DEFAULT 'awaiting_upload' NOT NULL,
	"presign_expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_documents_lifecycle_shape" CHECK (("master_documents"."status" = 'awaiting_upload'
             and "master_documents"."submitted_at" is null
             and "master_documents"."size_bytes" is null
             and "master_documents"."verified_content_type" is null)
          or ("master_documents"."status" <> 'awaiting_upload'
             and "master_documents"."submitted_at" is not null
             and "master_documents"."size_bytes" is not null
             and "master_documents"."verified_content_type" is not null)),
	CONSTRAINT "master_documents_size_positive" CHECK ("master_documents"."size_bytes" is null or "master_documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "master_verification_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"from_status" "master_verification_status" NOT NULL,
	"to_status" "master_verification_status" NOT NULL,
	"actor_kind" "master_verification_actor_kind" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_verification_history_real_transition" CHECK ("master_verification_history"."from_status" <> "master_verification_history"."to_status"),
	CONSTRAINT "master_verification_history_actor_shape" CHECK (("master_verification_history"."actor_kind" = 'master') = ("master_verification_history"."actor_user_id" is not null)),
	CONSTRAINT "master_verification_history_reason_length" CHECK ("master_verification_history"."reason" is null or length(btrim("master_verification_history"."reason")) between 1 and 600)
);
--> statement-breakpoint
ALTER TABLE "master_documents" ADD CONSTRAINT "master_documents_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_verification_history" ADD CONSTRAINT "master_verification_history_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_verification_history" ADD CONSTRAINT "master_verification_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_documents_storage_key_unique" ON "master_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "master_documents_pending_upload_unique" ON "master_documents" USING btree ("master_id","document_type") WHERE "master_documents"."status" = 'awaiting_upload';--> statement-breakpoint
CREATE UNIQUE INDEX "master_documents_live_unique" ON "master_documents" USING btree ("master_id","document_type") WHERE "master_documents"."superseded_at" is null and "master_documents"."status" <> 'awaiting_upload';--> statement-breakpoint
CREATE INDEX "master_documents_master_idx" ON "master_documents" USING btree ("master_id","document_type");--> statement-breakpoint
CREATE INDEX "master_verification_history_master_idx" ON "master_verification_history" USING btree ("master_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written: `drizzle-kit` does not model triggers, and this one is the
-- difference between an audit trail and a table the application promises not
-- to rewrite. A verification decision is a trust decision about someone's
-- access to a stranger's home; a record of it that any later query could
-- quietly amend is indistinguishable from no record at all
-- (docs/product/admin-flow.md, ADR-0023).
--
-- `FOR EACH ROW ... BEFORE UPDATE OR DELETE` covers the ordinary statements.
-- The second trigger exists because TRUNCATE bypasses row-level triggers
-- entirely — it is the one statement that would otherwise empty the table
-- without firing anything.
CREATE FUNCTION master_verification_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'master_verification_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER master_verification_history_append_only
  BEFORE UPDATE OR DELETE ON master_verification_history
  FOR EACH ROW EXECUTE FUNCTION master_verification_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER master_verification_history_no_truncate
  BEFORE TRUNCATE ON master_verification_history
  FOR EACH STATEMENT EXECUTE FUNCTION master_verification_history_is_append_only();
