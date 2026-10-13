-- Issue #329: what a setup link is for. Every existing link is an invitation
-- or a second-factor reset ('setup'); a password reset keeps the enrolled
-- authenticator and sets only a password.
CREATE TYPE "public"."admin_invitation_purpose" AS ENUM('setup', 'password_reset');--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD COLUMN "purpose" "admin_invitation_purpose" DEFAULT 'setup' NOT NULL;