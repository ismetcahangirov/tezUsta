CREATE TYPE "public"."review_author_role" AS ENUM('customer', 'master');--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"master_id" uuid NOT NULL,
	"author_role" "review_author_role" NOT NULL,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revealed_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by_admin_id" uuid,
	"removal_reason" text,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_comment_length" CHECK ("reviews"."comment" is null or (char_length("reviews"."comment") <= 500 and length(btrim("reviews"."comment")) >= 1)),
	CONSTRAINT "reviews_removal_complete" CHECK (("reviews"."removed_at" is null) = ("reviews"."removed_by_admin_id" is null)
          and ("reviews"."removed_at" is null) = ("reviews"."removal_reason" is null)),
	CONSTRAINT "reviews_removal_reason_length" CHECK ("reviews"."removal_reason" is null or length(btrim("reviews"."removal_reason")) between 1 and 600)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "rating_sum" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_removed_by_admin_id_admin_users_id_fk" FOREIGN KEY ("removed_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_id_parties_unique" ON "orders" USING btree ("id","customer_id","master_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_parties_fk" FOREIGN KEY ("order_id","customer_id","master_id") REFERENCES "public"."orders"("id","customer_id","master_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_order_author_unique" ON "reviews" USING btree ("order_id","author_role");--> statement-breakpoint
CREATE INDEX "reviews_about_master_idx" ON "reviews" USING btree ("master_id","revealed_at" desc) WHERE "reviews"."author_role" = 'customer' and "reviews"."revealed_at" is not null and "reviews"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "reviews_about_customer_idx" ON "reviews" USING btree ("customer_id","revealed_at" desc) WHERE "reviews"."author_role" = 'master' and "reviews"."revealed_at" is not null and "reviews"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "reviews_sealed_order_idx" ON "reviews" USING btree ("order_id") WHERE "reviews"."revealed_at" is null;--> statement-breakpoint
CREATE INDEX "reviews_removed_by_admin_idx" ON "reviews" USING btree ("removed_by_admin_id") WHERE "reviews"."removed_by_admin_id" is not null;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_rating_aggregate" CHECK ("customers"."rating_count" >= 0 and "customers"."rating_sum" >= 0 and "customers"."rating_sum" <= "customers"."rating_count" * 5);