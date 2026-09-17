CREATE TABLE "geocode_cache" (
	"normalised_address" text PRIMARY KEY NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"place_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geocode_cache_point_on_earth" CHECK ("geocode_cache"."latitude" between -90 and 90 and "geocode_cache"."longitude" between -180 and 180),
	CONSTRAINT "geocode_cache_licence_ttl" CHECK ("geocode_cache"."expires_at" <= "geocode_cache"."updated_at" + interval '30 days')
);
--> statement-breakpoint
CREATE INDEX "geocode_cache_expires_at_idx" ON "geocode_cache" USING btree ("expires_at");