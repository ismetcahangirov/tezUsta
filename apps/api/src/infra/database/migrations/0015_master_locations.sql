-- HAND-EDITED after `drizzle-kit generate`, in three places and deliberately.
--
-- 1. THE SRID TYPMOD. drizzle-kit emitted `"position" geometry(point)`:
--    `PgGeometryObject.getSQLType()` in drizzle-orm@0.45.2 returns that literal
--    string and ignores the `srid: 4326` in the column config entirely, exactly
--    as ADR-0018 records and as `0005_customer_addresses.sql` already had to
--    correct. The typmod is written here so the database, not a convention, is
--    what guarantees every row is in one reference system.
--
--    The typmod then rejects the `point(x y)` literal Drizzle's own driver
--    mapper produces, which Postgres reads as SRID 0. That is why
--    `MasterLocationRepository` writes this column through
--    ST_SetSRID(ST_MakePoint(lng, lat), 4326), the same as
--    `AddressesRepository`. Reads are unaffected: drizzle's parseEWKB skips
--    the SRID field Postgres now returns.
--
-- 2. THE APPEND-ONLY TRIGGERS, which drizzle-kit does not model at all — the
--    same pair `order_status_history` and `master_verification_history` carry,
--    with one deliberate difference described below.
--
-- 3. Nothing was changed about `master_locations_position_idx`. ADR-0018
--    predicted `drizzle-kit generate` "will not produce this index"; against
--    drizzle-kit@0.31.10 it did, emitting `USING gist (("position"::geography))`
--    from the `sql` template in the schema. Recorded here because CLAUDE.md §9
--    says the artifact wins over the document, and because the next person
--    reading that ADR will otherwise hand-write an index that is already there.
--    What has NOT changed is why the cast matters: an index on the bare
--    geometry column cannot serve a `::geography` predicate, and Postgres says
--    nothing when it falls back to a sequential scan. The plan is asserted in
--    `master-location.e2e.test.ts`, which is the check that actually holds.

CREATE TABLE "master_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_id" uuid NOT NULL,
	"position" geometry(Point,4326) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_locations_position_on_earth" CHECK (ST_X("master_locations"."position") between -180 and 180 and ST_Y("master_locations"."position") between -90 and 90)
);
--> statement-breakpoint
ALTER TABLE "master_locations" ADD CONSTRAINT "master_locations_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "master_locations_position_idx" ON "master_locations" USING gist (("position"::geography));--> statement-breakpoint
CREATE INDEX "master_locations_master_recent_idx" ON "master_locations" USING btree ("master_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
-- A position trail is evidence. An order dispute turns on where a master
-- actually was and when, and a trail the application merely promises not to
-- rewrite is a trail whose integrity depends on every future query, migration
-- and admin console being careful (docs/architecture/database-architecture.md:
-- "master_locations is append-only and retention-bounded").
--
-- THE ONE DIFFERENCE from the other two append-only tables: retention. The
-- same document requires this trail to be aged out, because precise location
-- history is personal data and "keep everything forever is a liability, not a
-- feature" — so unlike an audit log, this table has a legitimate reason to
-- delete its own rows. A blanket DELETE ban would make the privacy rule
-- unenforceable, and dropping the ban would make the integrity rule
-- unenforceable.
--
-- The escape hatch is therefore explicit, narrow and transaction-scoped, and
-- it carries the CUTOFF rather than an on/off flag.
--
-- A flag would have opened the door much wider than retention needs: while it
-- was on, an unqualified `DELETE FROM master_locations` would have erased every
-- master's CURRENT position — the row dispatch reads — and the trigger would
-- have permitted it. Retention only ever needs to forget rows past a cutoff, so
-- that is what the setting says:
--
--   `tezusta.location_retention` holds the timestamptz before which rows may be
--   deleted. `MasterLocationRepository.pruneTrail` publishes it with
--   `set_config(..., true)` — the `SET LOCAL` form — from the same single
--   evaluation it then deletes with, so the value the trigger checks each row
--   against and the value the DELETE filters on cannot disagree. `SET LOCAL`
--   reverts at commit, so no pooled connection carries the permission into the
--   next request.
--
-- Everything else raises: a DELETE of a row at or after the cutoff, a DELETE
-- with the setting unset, empty or unparseable, and every DELETE from an admin
-- console, a stray script or a future migration — exactly as on
-- `order_status_history`. UPDATE is never permitted at any setting: there is no
-- retention argument for editing a recorded position, only for forgetting it.
--
-- Two details keep the failure mode closed rather than loud or open:
-- `current_setting(..., true)` is the missing-ok form, without which an unset
-- setting raises inside the trigger and turns every ordinary DELETE's error
-- message into the wrong one; and `nullif(…, '')` covers a setting that has
-- been RESET, which reads back as the empty string rather than NULL. A NULL
-- cutoff means refuse.
--
-- The `OLD.recorded_at` test is nested inside `IF TG_OP = 'DELETE'` rather than
-- flattened into one AND: Postgres does not promise to short-circuit AND, and
-- `OLD` is unassigned in the statement-level TRUNCATE trigger below.
CREATE FUNCTION master_locations_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    BEGIN
      cutoff := nullif(current_setting('tezusta.location_retention', true), '')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      cutoff := NULL;
    END;

    IF cutoff IS NOT NULL AND OLD.recorded_at < cutoff THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'master_locations is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER master_locations_append_only
  BEFORE UPDATE OR DELETE ON master_locations
  FOR EACH ROW EXECUTE FUNCTION master_locations_is_append_only();--> statement-breakpoint
-- TRUNCATE bypasses row-level triggers entirely, and it is not a retention
-- mechanism: retention forgets one master's old rows, TRUNCATE forgets every
-- master's current one. No escape hatch, at any setting.
CREATE TRIGGER master_locations_no_truncate
  BEFORE TRUNCATE ON master_locations
  FOR EACH STATEMENT EXECUTE FUNCTION master_locations_is_append_only();
