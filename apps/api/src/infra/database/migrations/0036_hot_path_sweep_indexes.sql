CREATE INDEX "sessions_revoked_at_idx" ON "sessions" USING btree ("revoked_at") WHERE "sessions"."revoked_at" is not null;--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_revoked_at_idx" ON "admin_sessions" USING btree ("revoked_at") WHERE "admin_sessions"."revoked_at" is not null;--> statement-breakpoint
CREATE INDEX "order_photos_abandoned_idx" ON "order_photos" USING btree ("submitted_at") WHERE "order_photos"."status" = 'confirmed' and "order_photos"."order_id" is null;