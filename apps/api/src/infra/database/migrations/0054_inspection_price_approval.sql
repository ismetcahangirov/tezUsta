CREATE TYPE "public"."order_price_event_kind" AS ENUM('quoted', 'approved');--> statement-breakpoint
CREATE TABLE "order_price_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "order_price_event_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_price_events_amount_positive" CHECK ("order_price_events"."amount_minor" > 0)
);
--> statement-breakpoint
-- Edited by hand (ADR-0060 § 6): added nullable, backfilled from each
-- order's service, then made NOT NULL. The generated single statement would
-- fail on any database that already holds orders.
ALTER TABLE "orders" ADD COLUMN "pricing_kind" "service_pricing_kind";--> statement-breakpoint
UPDATE "orders" SET "pricing_kind" = "services"."pricing_kind" FROM "services" WHERE "services"."id" = "orders"."service_id";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "pricing_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "price_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "price_declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_price_events" ADD CONSTRAINT "order_price_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_price_events" ADD CONSTRAINT "order_price_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_price_events_order_idx" ON "order_price_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_price_events_actor_user_idx" ON "order_price_events" USING btree ("actor_user_id","created_at" desc);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_approval_shape" CHECK ("orders"."price_approved_at" is null
          or ("orders"."pricing_kind" = 'inspection' and "orders"."price_minor" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_decline_shape" CHECK ("orders"."price_declined_at" is null
          or ("orders"."status" = 'CANCELLED'
              and "orders"."pricing_kind" = 'inspection'
              and "orders"."price_minor" is not null
              and "orders"."price_approved_at" is null));--> statement-breakpoint
-- Hand-written below this line (ADR-0060). Drizzle generates no triggers.
--
-- The order's pricing shape is copied from its service by the database, on
-- every insert, whatever the writer passed. One writer, reading the service
-- in the statement that creates the order.
CREATE FUNCTION orders_pricing_kind_from_service() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT pricing_kind INTO NEW.pricing_kind FROM services WHERE id = NEW.service_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER orders_pricing_kind_from_service
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_pricing_kind_from_service();--> statement-breakpoint
-- And it never changes afterwards: the copy exists so that nothing moves it.
CREATE FUNCTION orders_pricing_kind_is_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pricing_kind IS DISTINCT FROM OLD.pricing_kind THEN
    RAISE EXCEPTION 'orders.pricing_kind is copied at creation and never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER orders_pricing_kind_is_fixed
  BEFORE UPDATE OF pricing_kind ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_pricing_kind_is_fixed();--> statement-breakpoint
-- The same pair of triggers as `order_status_history`: the row-level one
-- refuses UPDATE and DELETE, the statement-level one TRUNCATE.
CREATE FUNCTION order_price_events_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_price_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_price_events_append_only
  BEFORE UPDATE OR DELETE ON order_price_events
  FOR EACH ROW EXECUTE FUNCTION order_price_events_is_append_only();--> statement-breakpoint
CREATE TRIGGER order_price_events_no_truncate
  BEFORE TRUNCATE ON order_price_events
  FOR EACH STATEMENT EXECUTE FUNCTION order_price_events_is_append_only();
