-- EPIC 18, issue #177. The written channel between the two parties to one
-- order (ADR-0033).
--
-- HAND-EDITED after `drizzle-kit generate`, for one thing drizzle-kit does not
-- model at all: the write-once trigger on `messages` below. Everything above it
-- is generated output, unmodified.
--
-- Note the two `desc` index columns, which are generated output rather than an
-- edit: the schema spells them with `sql` instead of drizzle's `.desc()`,
-- because `.desc()` emits `DESC NULLS LAST` and a bare `ORDER BY ... DESC`
-- means `DESC NULLS FIRST` — the two do not match, and Postgres then cannot use
-- the index to avoid a sort. Measured on 5,000 rows: sequential scan plus Sort
-- with the NULLS LAST index, index-only scan with this one.

CREATE TYPE "public"."message_sender_kind" AS ENUM('customer', 'master');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"master_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_kind" "message_sender_kind" NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_body_length" CHECK (length(btrim("messages"."body")) between 1 and 2000),
	CONSTRAINT "messages_read_after_created" CHECK ("messages"."read_at" is null or "messages"."read_at" >= "messages"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_open_per_order" ON "conversations" USING btree ("order_id") WHERE "conversations"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "conversations_order_created_idx" ON "conversations" USING btree ("order_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "conversations_master_idx" ON "conversations" USING btree ("master_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "messages_unread_idx" ON "messages" USING btree ("conversation_id","sender_kind") WHERE "messages"."read_at" is null;--> statement-breakpoint
-- `messages` is a transcript, and ADR-0033 § 2 keeps it precisely so that a
-- dispute raised after an order completes has evidence about that job. Evidence
-- that can be quietly amended is not evidence, and a promise in the application
-- layer is only as good as every future query, migration and admin console.
--
-- **Write-once rather than append-only**, which is the one way this differs
-- from `order_status_history` and `master_locations`: a read receipt is a real
-- update to a real row. So the rule is not "no UPDATE" but "nothing may change
-- except `read_at`, and only from null" — a receipt is a fact about a moment
-- that already happened, and re-stamping one would move it.
--
-- The statement-level TRUNCATE trigger is here for the reason it is on the
-- other two tables: TRUNCATE bypasses row-level triggers entirely.
CREATE FUNCTION messages_is_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.sender_kind IS DISTINCT FROM OLD.sender_kind
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'messages is write-once: only read_at may be updated'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
      RAISE EXCEPTION 'messages.read_at is set once: it cannot be changed or cleared'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'messages is write-once: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER messages_write_once
  BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_is_write_once();--> statement-breakpoint
CREATE TRIGGER messages_no_truncate
  BEFORE TRUNCATE ON messages
  FOR EACH STATEMENT EXECUTE FUNCTION messages_is_write_once();
