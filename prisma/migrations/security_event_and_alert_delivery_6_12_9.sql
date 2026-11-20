-- Issue #1, section 6.12.9. Append-only security attempts, no identity FK,
-- request payloads, cookies, email addresses, one-time codes, JWTs or tokens.
DO $$ BEGIN
  CREATE TYPE "SecurityEventOutcome" AS ENUM ('ALLOWED', 'DENIED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SecurityEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" VARCHAR(128),
  "targetFingerprint" VARCHAR(64),
  "action" VARCHAR(96) NOT NULL,
  "outcome" "SecurityEventOutcome" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_action_createdAt_idx" ON "SecurityEvent"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_actorId_createdAt_idx" ON "SecurityEvent"("actorId", "createdAt");

CREATE TABLE IF NOT EXISTS "SecurityAlertDelivery" (
  "bucket" VARCHAR(160) NOT NULL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
