CREATE TYPE "public"."master_verification_status" AS ENUM('pending_verification', 'changes_requested', 'rejected', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "master_services" (
	"master_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"price_minor" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_services_master_id_service_id_pk" PRIMARY KEY("master_id","service_id"),
	CONSTRAINT "master_services_price_positive" CHECK ("master_services"."price_minor" is null or "master_services"."price_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "masters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"verification_status" "master_verification_status" DEFAULT 'pending_verification' NOT NULL,
	"suspended_at" timestamp with time zone,
	"is_available" boolean DEFAULT false NOT NULL,
	"rating_sum" integer DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "masters_display_name_length" CHECK (length(btrim("masters"."display_name")) between 1 and 80),
	CONSTRAINT "masters_bio_length" CHECK ("masters"."bio" is null or length(btrim("masters"."bio")) between 1 and 600),
	CONSTRAINT "masters_suspension_consistent" CHECK (("masters"."verification_status" = 'suspended') = ("masters"."suspended_at" is not null)),
	CONSTRAINT "masters_rating_aggregate" CHECK ("masters"."rating_count" >= 0 and "masters"."rating_sum" >= 0 and "masters"."rating_sum" <= "masters"."rating_count" * 5)
);
--> statement-breakpoint
ALTER TABLE "master_services" ADD CONSTRAINT "master_services_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_services" ADD CONSTRAINT "master_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "masters" ADD CONSTRAINT "masters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "master_services_service_master_idx" ON "master_services" USING btree ("service_id","master_id") WHERE "master_services"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "masters_user_id_unique" ON "masters" USING btree ("user_id");