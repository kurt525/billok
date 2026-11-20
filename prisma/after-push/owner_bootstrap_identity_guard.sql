-- Issue #1 6.12.1: one immutable owner identity, enforced by PostgreSQL.
-- Runs AFTER prisma db push on every deployment. Idempotent; on a fresh
-- database the table is present but the initial owner may not exist yet.
-- The singleton must have id=1; owner User.id and completed identity cannot
-- be replaced, erased, or reopened through Prisma or direct SQL.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public."OwnerBootstrap"'::regclass
      AND conname = 'owner_bootstrap_singleton_id_one'
  ) THEN
    ALTER TABLE public."OwnerBootstrap"
      ADD CONSTRAINT owner_bootstrap_singleton_id_one CHECK (id = 1);
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.billok_guard_owner_bootstrap_row()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  verified_at timestamp(3);
  suspended_at timestamp(3);
  is_placeholder boolean;
  active_passkeys integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billok_owner_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The sole owner is created UNVERIFIED by the LOCAL bootstrap only;
    -- setting completedAt in INSERT cannot bypass first-Passkey checks.
    IF NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'billok_owner_initial_completion_requires_passkey' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
  THEN
    RAISE EXCEPTION 'billok_owner_identity_immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD."completedAt" IS NULL AND NEW."completedAt" IS NOT NULL THEN
    -- First registration completes ONLY after a confirmed email and 1-3
    -- active WebAuthn credentials. This SELECT serializes with User updates.
    SELECT "emailVerified", "suspendedAt", "isPlaceholder"
      INTO verified_at, suspended_at, is_placeholder
      FROM public."User"
      WHERE id = NEW."userId"
      FOR SHARE;
    IF NOT FOUND OR verified_at IS NULL OR suspended_at IS NOT NULL
       OR is_placeholder IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'billok_owner_unverified_or_inactive' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO active_passkeys FROM public."PasskeyCredential"
      WHERE "userId" = NEW."userId" AND "revokedAt" IS NULL;
    IF active_passkeys < 1 OR active_passkeys > 3 THEN
      RAISE EXCEPTION 'billok_owner_passkey_required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS billok_owner_bootstrap_guard_row ON public."OwnerBootstrap";
CREATE TRIGGER billok_owner_bootstrap_guard_row
  BEFORE INSERT OR UPDATE OR DELETE ON public."OwnerBootstrap"
  FOR EACH ROW EXECUTE FUNCTION public.billok_guard_owner_bootstrap_row();

CREATE OR REPLACE FUNCTION public.billok_guard_owner_bootstrap_truncate()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION 'billok_owner_identity_immutable' USING ERRCODE = '23514';
END
$guard$;

DROP TRIGGER IF EXISTS billok_owner_bootstrap_guard_truncate ON public."OwnerBootstrap";
CREATE TRIGGER billok_owner_bootstrap_guard_truncate
  BEFORE TRUNCATE ON public."OwnerBootstrap"
  FOR EACH STATEMENT EXECUTE FUNCTION public.billok_guard_owner_bootstrap_truncate();


-- 6.12.10: protect the User ROW behind the immutable OwnerBootstrap.userId,
-- not only the bootstrap pointer. No API, direct SQL UPDATE/DELETE, import,
-- impersonation or concurrent transaction may suspend/reidentify the owner.
-- All application User IDs are immutable. Names, SBP details and legitimate
-- sessionSecurityVersion rotations remain writable.
CREATE OR REPLACE FUNCTION public.billok_guard_owner_account_row()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  owner_completed_at timestamp(3);
  is_owner boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'billok_user_id_immutable' USING ERRCODE = '23514';
  END IF;
  -- SELECT FOR SHARE serializes with changes to OwnerBootstrap, and all
  -- owner workflows first lock User, then inspect the singleton.
  SELECT "completedAt" INTO owner_completed_at
    FROM public."OwnerBootstrap" WHERE id = 1 AND "userId" = OLD.id
    FOR SHARE;
  is_owner := FOUND;
  IF NOT is_owner THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billok_owner_account_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."suspendedAt" IS NOT NULL
    OR NEW."isPlaceholder" IS DISTINCT FROM false
    OR (owner_completed_at IS NOT NULL AND (
      NEW."emailVerified" IS DISTINCT FROM OLD."emailVerified"
      OR NEW.email IS DISTINCT FROM OLD.email
      OR NEW."webAuthnUserHandle" IS DISTINCT FROM OLD."webAuthnUserHandle"
      OR NEW."registrationEmailVerificationRequired" IS DISTINCT FROM true
    ))
  THEN
    RAISE EXCEPTION 'billok_owner_account_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS billok_owner_user_row_guard ON public."User";
CREATE TRIGGER billok_owner_user_row_guard
  BEFORE UPDATE OR DELETE ON public."User"
  FOR EACH ROW EXECUTE FUNCTION public.billok_guard_owner_account_row();
