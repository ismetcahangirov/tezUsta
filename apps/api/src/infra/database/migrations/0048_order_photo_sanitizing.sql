ALTER TABLE "order_photos" ADD COLUMN "sanitized_key" text;--> statement-breakpoint
ALTER TABLE "order_photos" ADD COLUMN "sanitized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_photos" ADD COLUMN "sanitize_failure" text;--> statement-breakpoint
CREATE INDEX "order_photos_sanitize_pending_idx" ON "order_photos" USING btree ("submitted_at") WHERE "order_photos"."status" <> 'awaiting_upload' and "order_photos"."sanitized_at" is null and "order_photos"."sanitize_failure" is null;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_sanitize_shape" CHECK (("order_photos"."sanitized_at" is null and "order_photos"."sanitize_failure" is null)
          or ("order_photos"."status" <> 'awaiting_upload'
             and (("order_photos"."sanitized_at" is not null
                   and "order_photos"."sanitize_failure" is null
                   and "order_photos"."sanitized_key" = "order_photos"."storage_key")
                  or ("order_photos"."sanitized_at" is null and "order_photos"."sanitize_failure" is not null))));