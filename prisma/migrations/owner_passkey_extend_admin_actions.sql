-- Issue #1 6.12.4.1: extend one-time owner WebAuthn proof to typed
-- administrative actions. No action becomes executable until its own
-- endpoint performs an atomic same-transaction consume and owner recheck.
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'USER_SUSPEND';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'USER_UNSUSPEND';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'USER_DELETE';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'SYSTEM_INVITE_CREATE';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'SYSTEM_INVITE_REVOKE';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'REGISTRATION_MODE_UPDATE';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'OWNER_SETTING_UPDATE';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'IMPERSONATE';
ALTER TYPE "OwnerPasskeyActionType" ADD VALUE IF NOT EXISTS 'ADMIN_EXPORT';

ALTER TABLE "WebAuthnChallenge"
  ADD COLUMN IF NOT EXISTS "ownerActionTargetId" VARCHAR(128);
ALTER TABLE "OwnerPasskeyActionProof"
  ADD COLUMN IF NOT EXISTS "ownerActionTargetId" VARCHAR(128);
