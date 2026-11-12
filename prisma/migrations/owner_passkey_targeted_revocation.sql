-- Issue #1 6.8.2.2: account-bound, one-target, signed Passkey revocation.
ALTER TYPE "WebAuthnChallengePurpose" ADD VALUE IF NOT EXISTS 'OWNER_REVOKE';
ALTER TABLE "WebAuthnChallenge"
  ADD COLUMN IF NOT EXISTS "targetCredentialRowId" TEXT;
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'OWNER_PASSKEY_REVOKED';
