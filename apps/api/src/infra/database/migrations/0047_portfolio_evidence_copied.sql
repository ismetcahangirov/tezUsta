ALTER TABLE "portfolio_posts" DROP CONSTRAINT "portfolio_posts_evidence_shape";--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD COLUMN "evidence_copied_at" timestamp with time zone;--> statement-breakpoint
-- Hand-written (#369): a moved post was copied first, so the CHECK below holds for
-- every row already here. An unmoved one may have been copied too; its next move
-- attempt records it.
UPDATE "portfolio_posts" SET "evidence_copied_at" = "evidence_moved_at" WHERE "evidence_moved_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_posts" ADD CONSTRAINT "portfolio_posts_evidence_shape" CHECK (("portfolio_posts"."evidence_moved_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_purged_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_attempted_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_copied_at" is null or "portfolio_posts"."removed_at" is not null)
          and ("portfolio_posts"."evidence_moved_at" is null or "portfolio_posts"."evidence_copied_at" is not null));