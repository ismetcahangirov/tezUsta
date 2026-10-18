ALTER TABLE "message_attachments" ADD COLUMN "sanitized_key" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "sanitized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "sanitize_failure" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_sanitize_shape" CHECK (("message_attachments"."sanitized_at" is null and "message_attachments"."sanitize_failure" is null)
          or ("message_attachments"."status" <> 'awaiting_upload'
             and (("message_attachments"."sanitized_at" is not null
                   and "message_attachments"."sanitize_failure" is null
                   and "message_attachments"."sanitized_key" = "message_attachments"."storage_key")
                  or ("message_attachments"."sanitized_at" is null
                      and "message_attachments"."sanitize_failure" is not null
                      and "message_attachments"."message_id" is null))));