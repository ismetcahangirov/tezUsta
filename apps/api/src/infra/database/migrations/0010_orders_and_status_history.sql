CREATE TYPE "public"."order_actor_kind" AS ENUM('customer', 'master', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'SEARCHING', 'ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'DISPUTED', 'RESOLVED', 'REFUNDED', 'NO_MASTER_FOUND', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status" NOT NULL,
	"to_status" "order_status" NOT NULL,
	"actor_kind" "order_actor_kind" NOT NULL,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_status_history_real_transition" CHECK ("order_status_history"."from_status" <> "order_status_history"."to_status"),
	CONSTRAINT "order_status_history_actor_shape" CHECK (("order_status_history"."actor_kind" in ('customer', 'master')) = ("order_status_history"."actor_user_id" is not null)
          and ("order_status_history"."actor_kind" = 'admin') = ("order_status_history"."actor_admin_id" is not null)),
	CONSTRAINT "order_status_history_reason_length" CHECK ("order_status_history"."reason" is null or length(btrim("order_status_history"."reason")) between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"master_id" uuid,
	"status" "order_status" NOT NULL,
	"description" text NOT NULL,
	"price_minor" bigint,
	"redispatch_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_description_length" CHECK (length(btrim("orders"."description")) between 1 and 2000),
	CONSTRAINT "orders_idempotency_key_length" CHECK (length(btrim("orders"."idempotency_key")) between 1 and 128),
	CONSTRAINT "orders_price_positive" CHECK ("orders"."price_minor" is null or "orders"."price_minor" > 0),
	CONSTRAINT "orders_redispatch_count_non_negative" CHECK ("orders"."redispatch_count" >= 0),
	CONSTRAINT "orders_price_requires_master" CHECK ("orders"."price_minor" is null or "orders"."master_id" is not null),
	CONSTRAINT "orders_accepted_at_requires_master" CHECK ("orders"."accepted_at" is null or "orders"."master_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_admin_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_status_history_actor_admin_idx" ON "order_status_history" USING btree ("actor_admin_id","created_at" DESC NULLS LAST) WHERE "order_status_history"."actor_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "order_status_history_actor_user_idx" ON "order_status_history" USING btree ("actor_user_id","created_at" DESC NULLS LAST) WHERE "order_status_history"."actor_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_customer_idempotency_key_unique" ON "orders" USING btree ("customer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_active_per_master" ON "orders" USING btree ("master_id") WHERE "orders"."status" in ('ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS');--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_master_created_idx" ON "orders" USING btree ("master_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_address_idx" ON "orders" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "orders_service_idx" ON "orders" USING btree ("service_id");--> statement-breakpoint
-- `order_status_history` is the record of what happened to an order and who
-- made it happen. A trail the application merely promises not to rewrite is a
-- trail whose integrity depends on every future query, migration and admin
-- console being careful — and a disputed order whose history can be quietly
-- amended is indistinguishable from one with no history at all
-- (docs/product/admin-flow.md, ADR-0015).
--
-- Same pair of triggers as `master_verification_history`: the row-level one
-- covers UPDATE and DELETE, and the statement-level one exists because
-- TRUNCATE bypasses row-level triggers entirely.
CREATE FUNCTION order_status_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_status_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION order_status_history_is_append_only();--> statement-breakpoint
CREATE TRIGGER order_status_history_no_truncate
  BEFORE TRUNCATE ON order_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION order_status_history_is_append_only();
