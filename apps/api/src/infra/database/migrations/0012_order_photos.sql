CREATE TYPE "public"."order_photo_status" AS ENUM('awaiting_upload', 'confirmed', 'attached');--> statement-breakpoint
CREATE TABLE "order_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"storage_key" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"verified_content_type" text,
	"size_bytes" integer,
	"status" "order_photo_status" DEFAULT 'awaiting_upload' NOT NULL,
	"presign_expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_photos_lifecycle_shape" CHECK (("order_photos"."status" = 'awaiting_upload'
             and "order_photos"."submitted_at" is null
             and "order_photos"."size_bytes" is null
             and "order_photos"."verified_content_type" is null
             and "order_photos"."order_id" is null
             and "order_photos"."attached_at" is null)
          or ("order_photos"."status" = 'confirmed'
             and "order_photos"."submitted_at" is not null
             and "order_photos"."size_bytes" is not null
             and "order_photos"."verified_content_type" is not null
             and "order_photos"."order_id" is null
             and "order_photos"."attached_at" is null)
          or ("order_photos"."status" = 'attached'
             and "order_photos"."submitted_at" is not null
             and "order_photos"."size_bytes" is not null
             and "order_photos"."verified_content_type" is not null
             and "order_photos"."order_id" is not null
             and "order_photos"."attached_at" is not null)),
	CONSTRAINT "order_photos_size_positive" CHECK ("order_photos"."size_bytes" is null or "order_photos"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "photo_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_photos_storage_key_unique" ON "order_photos" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "order_photos_customer_idx" ON "order_photos" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "order_photos_order_idx" ON "order_photos" USING btree ("order_id") WHERE "order_photos"."order_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_photo_count_non_negative" CHECK ("orders"."photo_count" >= 0);