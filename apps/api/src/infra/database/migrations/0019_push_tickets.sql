ALTER TYPE "public"."device_revoked_reason" ADD VALUE 'unreachable';--> statement-breakpoint
CREATE TABLE "push_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"receipt_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_tickets_receipt_id_unique" ON "push_tickets" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "push_tickets_created_at_idx" ON "push_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "push_tickets_device_id_idx" ON "push_tickets" USING btree ("device_id");