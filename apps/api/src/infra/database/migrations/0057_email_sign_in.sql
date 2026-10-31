-- Written by hand (ADR-0072): sign-in moves from a phone number to an email
-- address, and the phone number leaves the account entirely.
--
-- otp_challenges rows are credentials that live five minutes at most, so they
-- are deleted rather than carried over: none of them could ever be redeemed
-- against an address.
DELETE FROM "otp_challenges";--> statement-breakpoint
DROP INDEX "otp_challenges_live_per_phone_unique";--> statement-breakpoint
ALTER TABLE "otp_challenges" RENAME COLUMN "phone_e164" TO "email";--> statement-breakpoint
CREATE UNIQUE INDEX "otp_challenges_live_per_email_unique" ON "otp_challenges" USING btree ("email") WHERE "otp_challenges"."consumed_at" is null and "otp_challenges"."invalidated_at" is null;--> statement-breakpoint
-- Every existing account is a pre-launch one: nobody has signed in for real,
-- because the SMS accounts were never opened. Each keeps its row, so orders,
-- reviews and profiles keep pointing at it, under an address in the reserved
-- `.invalid` TLD (RFC 2606) that can never receive mail, so it can never be
-- signed into again.
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
UPDATE "users" SET "email" = "id"::text || '@legacy.invalid';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
DROP INDEX "users_phone_e164_live_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "phone_e164";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_live_unique" ON "users" USING btree ("email") WHERE "users"."deleted_at" is null;
