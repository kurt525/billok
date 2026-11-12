-- Issue #1 6.10.2.3: additional owner registration requires a scoped ADD approval.
ALTER TABLE "WebAuthnChallenge"
  ADD COLUMN IF NOT EXISTS "approvalProofTokenHash" VARCHAR(64);

ALTER TYPE "AdminAction"
  ADD VALUE IF NOT EXISTS 'OWNER_PASSKEY_ADDED';
