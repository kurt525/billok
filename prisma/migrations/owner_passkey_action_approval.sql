-- Issue #1 6.10.2.2: signed, session- and operation-bound owner approvals.
CREATE TYPE "OwnerPasskeyActionType" AS ENUM ('ADD', 'RENAME', 'REVOKE');
ALTER TYPE "WebAuthnChallengePurpose" ADD VALUE IF NOT EXISTS 'OWNER_APPROVAL';

ALTER TABLE "WebAuthnChallenge"
  ADD COLUMN IF NOT EXISTS "ownerActionType" "OwnerPasskeyActionType",
  ADD COLUMN IF NOT EXISTS "sessionBindingHash" VARCHAR(64);

CREATE TABLE "OwnerPasskeyActionProof" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" VARCHAR(64) NOT NULL UNIQUE,
  "action" "OwnerPasskeyActionType" NOT NULL,
  "targetCredentialRowId" TEXT,
  "signerCredentialRowId" TEXT NOT NULL,
  "sessionBindingHash" VARCHAR(64) NOT NULL,
  "sessionSecurityVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OwnerPasskeyActionProof_userId_consumedAt_expiresAt_idx"
  ON "OwnerPasskeyActionProof"("userId", "consumedAt", "expiresAt");
