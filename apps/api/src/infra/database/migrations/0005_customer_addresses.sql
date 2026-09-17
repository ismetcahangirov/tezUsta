-- HAND-EDITED after `drizzle-kit generate`, in one place and deliberately.
--
-- drizzle-kit emitted `"position" geometry(point)`: `PgGeometryObject.getSQLType()`
-- in drizzle-orm@0.45.2 returns that literal string and ignores the `srid: 4326`
-- in the column config entirely. ADR-0018 records the same finding and its
-- consequence -- "an SRID constraint on the column must be written into the
-- migration by hand, or there will not be one" -- and issue #35 asks for
-- geometry(Point, 4326), so the typmod is written here.
--
-- The typmod then rejects the `point(x y)` literal Drizzle's own driver mapper
-- produces, which Postgres reads as SRID 0. That is why AddressesRepository
-- writes this column through ST_SetSRID(ST_MakePoint(lng, lat), 4326) rather
-- than as a Drizzle value. Reads are unaffected: drizzle's parseEWKB skips the
-- SRID field Postgres now returns.
--
-- There is no GiST index on this column on purpose: no query evaluates a
-- distance against `addresses`. ADR-0018's rule is to index the expression a
-- query actually evaluates, and adding one here would cost a write per saved
-- address to answer a question nobody asks.

CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text,
	"formatted_address" text NOT NULL,
	"building" text,
	"entrance" text,
	"floor" text,
	"apartment" text,
	"landmark_note" text,
	"position" geometry(Point,4326) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "addresses_text_lengths" CHECK (length(btrim("addresses"."formatted_address")) between 1 and 300
        and ("addresses"."label" is null or length(btrim("addresses"."label")) between 1 and 40)
        and ("addresses"."building" is null or length(btrim("addresses"."building")) between 1 and 40)
        and ("addresses"."entrance" is null or length(btrim("addresses"."entrance")) between 1 and 40)
        and ("addresses"."floor" is null or length(btrim("addresses"."floor")) between 1 and 40)
        and ("addresses"."apartment" is null or length(btrim("addresses"."apartment")) between 1 and 40)
        and ("addresses"."landmark_note" is null or length(btrim("addresses"."landmark_note")) between 1 and 300)),
	CONSTRAINT "addresses_position_on_earth" CHECK (ST_X("addresses"."position") between -180 and 180 and ST_Y("addresses"."position") between -90 and 90)
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_customer_live_idx" ON "addresses" USING btree ("customer_id","is_default" DESC NULLS LAST,"created_at" DESC NULLS LAST) WHERE "addresses"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_one_default_per_customer" ON "addresses" USING btree ("customer_id") WHERE "addresses"."is_default" and "addresses"."deleted_at" is null;