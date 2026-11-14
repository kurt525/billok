-- Issue #1 6.8.1.1: invalidate all existing Auth.js JWTs after recovery.
-- There are no production users yet, but keep the change safe for existing rows.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionSecurityVersion" INTEGER NOT NULL DEFAULT 0;
