CREATE TYPE "public"."session_surface" AS ENUM('app', 'web');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "surface" "session_surface" DEFAULT 'app' NOT NULL;