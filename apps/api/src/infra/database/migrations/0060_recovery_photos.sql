CREATE TYPE "public"."account_recovery_photo_kind" AS ENUM('selfie_with_id', 'id_card_front');--> statement-breakpoint
CREATE TYPE "public"."account_recovery_photo_status" AS ENUM('awaiting_upload', 'stored');--> statement-breakpoint
CREATE TABLE "account_recovery_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recovery_id" uuid NOT NULL,
	"kind" "account_recovery_photo_kind" NOT NULL,
	"status" "account_recovery_photo_status" DEFAULT 'awaiting_upload' NOT NULL,
	"storage_key" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"verified_content_type" text,
	"size_bytes" integer,
	"uploaded_by_admin_id" uuid NOT NULL,
	"presign_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone,
	CONSTRAINT "account_recovery_photos_stored_shape" CHECK (("account_recovery_photos"."status" = 'stored') = ("account_recovery_photos"."stored_at" is not null)
          and ("account_recovery_photos"."status" = 'stored') = ("account_recovery_photos"."size_bytes" is not null)
          and ("account_recovery_photos"."status" = 'stored') = ("account_recovery_photos"."verified_content_type" is not null)),
	CONSTRAINT "account_recovery_photos_size_positive" CHECK ("account_recovery_photos"."size_bytes" is null or "account_recovery_photos"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_recovery_photos" ADD CONSTRAINT "account_recovery_photos_recovery_id_account_recovery_requests_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."account_recovery_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_recovery_photos" ADD CONSTRAINT "account_recovery_photos_uploaded_by_admin_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_recovery_photos_kind_unique" ON "account_recovery_photos" USING btree ("recovery_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "account_recovery_photos_storage_key_unique" ON "account_recovery_photos" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "account_recovery_photos_uploaded_by_idx" ON "account_recovery_photos" USING btree ("uploaded_by_admin_id");--> statement-breakpoint
CREATE INDEX "account_recovery_photos_awaiting_idx" ON "account_recovery_photos" USING btree ("presign_expires_at") WHERE "account_recovery_photos"."status" = 'awaiting_upload';