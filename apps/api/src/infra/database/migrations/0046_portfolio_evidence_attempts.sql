ALTER TABLE "portfolio_posts" DROP CONSTRAINT "portfolio_posts_evidence_shape";--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD COLUMN "evidence_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD CONSTRAINT "portfolio_posts_evidence_shape" CHECK (("portfolio_posts"."evidence_moved_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_purged_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_attempted_at" is null or "portfolio_posts"."removed_at" is not null));