CREATE TYPE "public"."media_upload_status" AS ENUM('awaiting_upload', 'uploaded', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."portfolio_post_status" AS ENUM('draft', 'processing', 'published', 'failed', 'deleted');--> statement-breakpoint
CREATE TABLE "master_avatar_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"raw_storage_key" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"verified_content_type" text,
	"raw_size_bytes" integer,
	"status" "media_upload_status" DEFAULT 'awaiting_upload' NOT NULL,
	"failure_code" text,
	"presign_expires_at" timestamp with time zone NOT NULL,
	"thumb_key" text,
	"display_key" text,
	"renditions_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_avatar_uploads_upload_shape" CHECK (("master_avatar_uploads"."status" = 'awaiting_upload'
                and "master_avatar_uploads"."verified_content_type" is null
                and "master_avatar_uploads"."raw_size_bytes" is null
                and "master_avatar_uploads"."failure_code" is null)
             or ("master_avatar_uploads"."status" in ('uploaded', 'processing', 'ready')
                and "master_avatar_uploads"."verified_content_type" is not null
                and "master_avatar_uploads"."raw_size_bytes" is not null
                and "master_avatar_uploads"."raw_size_bytes" > 0
                and "master_avatar_uploads"."failure_code" is null)
             or ("master_avatar_uploads"."status" = 'failed'
                and "master_avatar_uploads"."failure_code" is not null)),
	CONSTRAINT "master_avatar_uploads_renditions_shape" CHECK (("master_avatar_uploads"."thumb_key" is null) = ("master_avatar_uploads"."display_key" is null)
          and ("master_avatar_uploads"."status" <> 'ready' or "master_avatar_uploads"."thumb_key" is not null)
          and ("master_avatar_uploads"."thumb_key" is null or "master_avatar_uploads"."status" in ('processing', 'ready', 'failed'))
          and ("master_avatar_uploads"."renditions_deleted_at" is null or "master_avatar_uploads"."thumb_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "portfolio_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"raw_storage_key" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"verified_content_type" text,
	"raw_size_bytes" integer,
	"status" "media_upload_status" DEFAULT 'awaiting_upload' NOT NULL,
	"failure_code" text,
	"presign_expires_at" timestamp with time zone NOT NULL,
	"thumb_key" text,
	"display_key" text,
	"width" integer,
	"height" integer,
	"bytes_total" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_media_position_non_negative" CHECK ("portfolio_media"."position" >= 0),
	CONSTRAINT "portfolio_media_upload_shape" CHECK (("portfolio_media"."status" = 'awaiting_upload'
                and "portfolio_media"."verified_content_type" is null
                and "portfolio_media"."raw_size_bytes" is null
                and "portfolio_media"."failure_code" is null)
             or ("portfolio_media"."status" in ('uploaded', 'processing', 'ready')
                and "portfolio_media"."verified_content_type" is not null
                and "portfolio_media"."raw_size_bytes" is not null
                and "portfolio_media"."raw_size_bytes" > 0
                and "portfolio_media"."failure_code" is null)
             or ("portfolio_media"."status" = 'failed'
                and "portfolio_media"."failure_code" is not null)),
	CONSTRAINT "portfolio_media_renditions_shape" CHECK (("portfolio_media"."status" = 'ready'
             and "portfolio_media"."thumb_key" is not null
             and "portfolio_media"."display_key" is not null
             and "portfolio_media"."width" is not null and "portfolio_media"."width" > 0
             and "portfolio_media"."height" is not null and "portfolio_media"."height" > 0
             and "portfolio_media"."bytes_total" is not null and "portfolio_media"."bytes_total" > 0)
          or ("portfolio_media"."status" in ('processing', 'failed')
             and ("portfolio_media"."thumb_key" is null) = ("portfolio_media"."display_key" is null)
             and "portfolio_media"."width" is null
             and "portfolio_media"."height" is null
             and "portfolio_media"."bytes_total" is null)
          or ("portfolio_media"."status" in ('awaiting_upload', 'uploaded')
             and "portfolio_media"."thumb_key" is null
             and "portfolio_media"."display_key" is null
             and "portfolio_media"."width" is null
             and "portfolio_media"."height" is null
             and "portfolio_media"."bytes_total" is null))
);
--> statement-breakpoint
CREATE TABLE "portfolio_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"caption" text,
	"service_id" uuid,
	"status" "portfolio_post_status" DEFAULT 'draft' NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by_admin_id" uuid,
	"removal_reason" text,
	"evidence_moved_at" timestamp with time zone,
	"evidence_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_posts_caption_length" CHECK ("portfolio_posts"."caption" is null
          or (char_length(btrim("portfolio_posts"."caption")) >= 1 and char_length("portfolio_posts"."caption") <= 2000)),
	CONSTRAINT "portfolio_posts_media_count_non_negative" CHECK ("portfolio_posts"."media_count" >= 0),
	CONSTRAINT "portfolio_posts_published_has_time" CHECK ("portfolio_posts"."status" <> 'published' or "portfolio_posts"."published_at" is not null),
	CONSTRAINT "portfolio_posts_deleted_has_time" CHECK ("portfolio_posts"."status" <> 'deleted' or "portfolio_posts"."deleted_at" is not null),
	CONSTRAINT "portfolio_posts_removal_shape" CHECK (("portfolio_posts"."removed_at" is null
             and "portfolio_posts"."removed_by_admin_id" is null
             and "portfolio_posts"."removal_reason" is null)
          or ("portfolio_posts"."removed_at" is not null
             and "portfolio_posts"."removed_by_admin_id" is not null
             and "portfolio_posts"."removal_reason" is not null
             and char_length(btrim("portfolio_posts"."removal_reason")) between 1 and 600)),
	CONSTRAINT "portfolio_posts_removed_not_deleted" CHECK ("portfolio_posts"."removed_at" is null or "portfolio_posts"."status" <> 'deleted'),
	CONSTRAINT "portfolio_posts_evidence_shape" CHECK (("portfolio_posts"."evidence_moved_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_purged_at" is null or "portfolio_posts"."evidence_moved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "masters" ADD COLUMN "avatar_thumb_key" text;--> statement-breakpoint
ALTER TABLE "masters" ADD COLUMN "avatar_display_key" text;--> statement-breakpoint
ALTER TABLE "masters" ADD COLUMN "portfolio_post_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "master_avatar_uploads" ADD CONSTRAINT "master_avatar_uploads_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_media" ADD CONSTRAINT "portfolio_media_post_id_portfolio_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."portfolio_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD CONSTRAINT "portfolio_posts_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD CONSTRAINT "portfolio_posts_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD CONSTRAINT "portfolio_posts_removed_by_admin_id_admin_users_id_fk" FOREIGN KEY ("removed_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_avatar_uploads_raw_storage_key_unique" ON "master_avatar_uploads" USING btree ("raw_storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "master_avatar_uploads_in_flight_unique" ON "master_avatar_uploads" USING btree ("master_id") WHERE "master_avatar_uploads"."status" in ('awaiting_upload', 'uploaded', 'processing');--> statement-breakpoint
CREATE INDEX "master_avatar_uploads_master_idx" ON "master_avatar_uploads" USING btree ("master_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "master_avatar_uploads_renditions_live_idx" ON "master_avatar_uploads" USING btree ("updated_at") WHERE "master_avatar_uploads"."thumb_key" is not null and "master_avatar_uploads"."renditions_deleted_at" is null;--> statement-breakpoint
CREATE INDEX "master_avatar_uploads_awaiting_upload_idx" ON "master_avatar_uploads" USING btree ("presign_expires_at") WHERE "master_avatar_uploads"."status" = 'awaiting_upload';--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_media_post_position_unique" ON "portfolio_media" USING btree ("post_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_media_raw_storage_key_unique" ON "portfolio_media" USING btree ("raw_storage_key");--> statement-breakpoint
CREATE INDEX "portfolio_media_awaiting_upload_idx" ON "portfolio_media" USING btree ("presign_expires_at") WHERE "portfolio_media"."status" = 'awaiting_upload';--> statement-breakpoint
CREATE INDEX "portfolio_posts_feed_idx" ON "portfolio_posts" USING btree ("master_id","published_at" desc,"id" desc) WHERE "portfolio_posts"."status" = 'published' and "portfolio_posts"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "portfolio_posts_master_created_idx" ON "portfolio_posts" USING btree ("master_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "portfolio_posts_created_idx" ON "portfolio_posts" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "portfolio_posts_sweep_idx" ON "portfolio_posts" USING btree ("updated_at") WHERE "portfolio_posts"."status" in ('draft', 'failed', 'deleted');--> statement-breakpoint
CREATE INDEX "portfolio_posts_removed_idx" ON "portfolio_posts" USING btree ("removed_at") WHERE "portfolio_posts"."removed_at" is not null and "portfolio_posts"."evidence_purged_at" is null;--> statement-breakpoint
CREATE INDEX "portfolio_posts_service_idx" ON "portfolio_posts" USING btree ("service_id") WHERE "portfolio_posts"."service_id" is not null;--> statement-breakpoint
CREATE INDEX "portfolio_posts_removed_by_admin_idx" ON "portfolio_posts" USING btree ("removed_by_admin_id") WHERE "portfolio_posts"."removed_by_admin_id" is not null;--> statement-breakpoint
ALTER TABLE "masters" ADD CONSTRAINT "masters_portfolio_post_count_non_negative" CHECK ("masters"."portfolio_post_count" >= 0);--> statement-breakpoint
ALTER TABLE "masters" ADD CONSTRAINT "masters_avatar_pair" CHECK (("masters"."avatar_thumb_key" is null) = ("masters"."avatar_display_key" is null));