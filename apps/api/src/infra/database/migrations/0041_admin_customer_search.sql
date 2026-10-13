-- Issue #328: the admin customer list. Newest first by keyset, and a
-- case-insensitive prefix search on the display name (text_pattern_ops, since
-- the collation is not C and pg_trgm is not installed).
CREATE INDEX "customers_created_idx" ON "customers" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "customers_display_name_prefix_idx" ON "customers" USING btree (lower("display_name") text_pattern_ops);