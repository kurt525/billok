-- Issue #1 6.12.7: auditable owner recovery request without logging email, tokens or links.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'OWNER_PASSKEY_RECOVERY_REQUESTED';
