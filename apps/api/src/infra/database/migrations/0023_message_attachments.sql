-- EPIC 18, issue #181. Photographs on a message, on the presigned-upload path
-- `order_photos` already uses (ADR-0033 § 4, ADR-0024).
--
-- HAND-EDITED after `drizzle-kit generate`, for one thing drizzle-kit does not
-- model: the trigger at the bottom that makes an attached photo as write-once
-- as the message it belongs to. Everything above it is generated output,
-- unmodified.
--
-- The `messages` CHECK is replaced rather than altered in place, because
-- Postgres has no ALTER for a CHECK's expression. Adding the new one validates
-- every existing row, and every existing row satisfies it: the new rule only
-- admits one more shape — the empty body of a photo sent on its own — and
-- still refuses a whitespace-only body.

CREATE TYPE "public"."message_attachment_status" AS ENUM('awaiting_upload', 'confirmed', 'attached');--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploader_kind" "message_sender_kind" NOT NULL,
	"message_id" uuid,
	"storage_key" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"verified_content_type" text,
	"size_bytes" integer,
	"status" "message_attachment_status" DEFAULT 'awaiting_upload' NOT NULL,
	"presign_expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_lifecycle_shape" CHECK (("message_attachments"."status" = 'awaiting_upload'
             and "message_attachments"."submitted_at" is null
             and "message_attachments"."size_bytes" is null
             and "message_attachments"."verified_content_type" is null
             and "message_attachments"."message_id" is null
             and "message_attachments"."attached_at" is null)
          or ("message_attachments"."status" = 'confirmed'
             and "message_attachments"."submitted_at" is not null
             and "message_attachments"."size_bytes" is not null
             and "message_attachments"."verified_content_type" is not null
             and "message_attachments"."message_id" is null
             and "message_attachments"."attached_at" is null)
          or ("message_attachments"."status" = 'attached'
             and "message_attachments"."submitted_at" is not null
             and "message_attachments"."size_bytes" is not null
             and "message_attachments"."verified_content_type" is not null
             and "message_attachments"."message_id" is not null
             and "message_attachments"."attached_at" is not null)),
	CONSTRAINT "message_attachments_size_positive" CHECK ("message_attachments"."size_bytes" is null or "message_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_body_length";--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_storage_key_unique" ON "message_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_pending_upload_unique" ON "message_attachments" USING btree ("conversation_id","uploader_kind") WHERE "message_attachments"."status" = 'awaiting_upload';--> statement-breakpoint
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id") WHERE "message_attachments"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "message_attachments_unsent_created_idx" ON "message_attachments" USING btree ("created_at") WHERE "message_attachments"."message_id" is null;--> statement-breakpoint
CREATE INDEX "message_attachments_conversation_idx" ON "message_attachments" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_shape" CHECK ("messages"."body" = '' or length(btrim("messages"."body")) between 1 and 2000);
--> statement-breakpoint
-- An attached photo is part of the transcript, and ADR-0033 § 2 keeps the
-- transcript for disputes. `messages_is_write_once` (0021) already stops the
-- message itself being rewritten or deleted; without this, the photos on it
-- could still be detached, swapped for others, or deleted out from under it,
-- and "the master sent a photo of the finished tap" would be evidence anyone
-- with a SQL console could quietly withdraw.
--
-- **Only once attached.** A row with no `message_id` is a photo still being
-- composed, or abandoned: confirm has to move it `awaiting_upload` ->
-- `confirmed`, send has to move it to `attached`, and the maintenance sweep
-- has to delete it when nobody ever sends it. All three act on a row whose
-- `OLD.message_id` is null, and that is exactly the line this draws.
--
-- The statement-level TRUNCATE trigger is here for the reason it is on
-- `messages`: TRUNCATE bypasses row-level triggers entirely, and it cannot
-- tell an attached row from an unattached one, so it is refused outright.
CREATE FUNCTION message_attachments_is_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'message_attachments cannot be truncated: attached photos are part of a transcript'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.message_id IS NOT NULL THEN
    RAISE EXCEPTION 'message_attachments is write-once once attached: % is not permitted', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER message_attachments_write_once
  BEFORE UPDATE OR DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION message_attachments_is_write_once();--> statement-breakpoint
CREATE TRIGGER message_attachments_no_truncate
  BEFORE TRUNCATE ON message_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION message_attachments_is_write_once();
