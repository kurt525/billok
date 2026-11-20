-- Issue #1 6.10.2.4: audit a targeted, fresh signed owner rename.
-- Targeted revocation already has OWNER_PASSKEY_REVOKED.
ALTER TYPE "AdminAction"
  ADD VALUE IF NOT EXISTS 'OWNER_PASSKEY_RENAMED';
