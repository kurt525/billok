-- Issue #1 6.8.1.3: separate email recovery tokens from invitation confirmations.
-- Existing rows are untouched; raw recovery tokens are never stored.
CREATE TABLE IF NOT EXISTS "PasskeyRecoveryRequest" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "tokenHash" VARCHAR(64) NOT NULL UNIQUE,
  "emailHash" VARCHAR(64) NOT NULL,
  "challengeHash" VARCHAR(64),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PasskeyRecoveryRequest_userId_createdAt_idx"
  ON "PasskeyRecoveryRequest" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "PasskeyRecoveryRequest_expiresAt_idx"
  ON "PasskeyRecoveryRequest" ("expiresAt");
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'PASSKEY_RECOVERY_COMPLETED';
