-- Issue #1 3.25.2.2 — no plaintext shared bearer in PostgreSQL.
-- Stable hash: 64 lowercase SHA-256 hex characters, and sealed AES-256-GCM
-- v1 ciphertext: nonce(12) + GCM tag(16) + 43-byte bearer, all base64url.
-- Idempotent after Prisma db push. Test-only pre-release legacy cuid rows must
-- be removed before enabling this constraint; do NOT weaken the constraint.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public."GuestSplit"'::regclass
      AND conname = 'guest_share_link_storage_format'
  ) THEN
    ALTER TABLE public."GuestSplit" ADD CONSTRAINT guest_share_link_storage_format
      CHECK (
        "shareToken" ~ '^[0-9a-f]{64}$'
        AND "shareTokenSealed" IS NOT NULL
        AND "shareTokenSealed" ~ '^v1[.][A-Za-z0-9_-]{95}$'
      );
  END IF;
END
$guard$;
