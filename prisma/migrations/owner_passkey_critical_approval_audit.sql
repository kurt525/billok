-- Issue #1 6.10.3: auditable successful owner step-up for Passkey management.
-- Never store raw proof tokens, session cookies or WebAuthn assertions in the log.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'OWNER_PASSKEY_APPROVAL_VERIFIED';
