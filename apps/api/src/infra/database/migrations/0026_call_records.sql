CREATE INDEX "calls_accepted_answered_idx" ON "calls" USING btree ("answered_at") WHERE "calls"."status" = 'ACCEPTED';--> statement-breakpoint
CREATE INDEX "calls_ringing_started_idx" ON "calls" USING btree ("started_at") WHERE "calls"."status" = 'RINGING';--> statement-breakpoint
CREATE INDEX "calls_started_idx" ON "calls" USING btree ("started_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "calls_caller_started_idx" ON "calls" USING btree ("caller_id","started_at" desc);--> statement-breakpoint
CREATE INDEX "calls_callee_started_idx" ON "calls" USING btree ("callee_id","started_at" desc);