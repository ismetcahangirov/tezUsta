CREATE TYPE "public"."order_offer_status" AS ENUM('offered', 'declined', 'expired', 'accepted', 'lost');--> statement-breakpoint
CREATE TABLE "order_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"master_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"radius_m" integer NOT NULL,
	"distance_m" integer NOT NULL,
	"status" "order_offer_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_offers_round_positive" CHECK ("order_offers"."round" >= 1),
	CONSTRAINT "order_offers_radius_positive" CHECK ("order_offers"."radius_m" > 0),
	CONSTRAINT "order_offers_distance_non_negative" CHECK ("order_offers"."distance_m" >= 0),
	CONSTRAINT "order_offers_response_consistent" CHECK (("order_offers"."status" in ('declined', 'accepted', 'lost')) = ("order_offers"."responded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "masters" ADD COLUMN "commission_debt_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_offers" ADD CONSTRAINT "order_offers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_offers" ADD CONSTRAINT "order_offers_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_offers_order_master_unique" ON "order_offers" USING btree ("order_id","master_id");--> statement-breakpoint
CREATE INDEX "order_offers_master_status_created_idx" ON "order_offers" USING btree ("master_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_offers_order_idx" ON "order_offers" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "masters" ADD CONSTRAINT "masters_commission_debt_non_negative" CHECK ("masters"."commission_debt_minor" >= 0);