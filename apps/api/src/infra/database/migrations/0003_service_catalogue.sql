CREATE TYPE "public"."service_pricing_kind" AS ENUM('fixed', 'inspection');--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" jsonb NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_categories_name_has_fallback" CHECK (jsonb_typeof("service_categories"."name") = 'object' and jsonb_exists("service_categories"."name", 'az') and length(btrim("service_categories"."name" ->> 'az')) > 0),
	CONSTRAINT "service_categories_slug_format" CHECK ("service_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" jsonb NOT NULL,
	"pricing_kind" "service_pricing_kind" NOT NULL,
	"base_price_minor" bigint,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_pricing_shape" CHECK (("services"."pricing_kind" = 'fixed' and "services"."base_price_minor" is not null and "services"."base_price_minor" > 0)
          or ("services"."pricing_kind" = 'inspection' and "services"."base_price_minor" is null)),
	CONSTRAINT "services_name_has_fallback" CHECK (jsonb_typeof("services"."name") = 'object' and jsonb_exists("services"."name", 'az') and length(btrim("services"."name" ->> 'az')) > 0),
	CONSTRAINT "services_slug_format" CHECK ("services"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_categories_slug_unique" ON "service_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "service_categories_active_order_idx" ON "service_categories" USING btree ("display_order","id") WHERE "service_categories"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "services_slug_unique" ON "services" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "services_category_active_order_idx" ON "services" USING btree ("category_id","display_order","id") WHERE "services"."is_active";--> statement-breakpoint
CREATE INDEX "services_active_order_idx" ON "services" USING btree ("display_order","id") WHERE "services"."is_active";