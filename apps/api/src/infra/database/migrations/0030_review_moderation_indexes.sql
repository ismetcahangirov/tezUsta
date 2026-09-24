CREATE INDEX "reviews_master_created_idx" ON "reviews" USING btree ("master_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "reviews_customer_created_idx" ON "reviews" USING btree ("customer_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "reviews_created_idx" ON "reviews" USING btree ("created_at" desc,"id" desc);