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
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billok_owner_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
  THEN
    RAISE EXCEPTION 'billok_owner_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS billok_owner_bootstrap_guard_row ON public."OwnerBootstrap";
CREATE TRIGGER billok_owner_bootstrap_guard_row
  BEFORE UPDATE OR DELETE ON public."OwnerBootstrap"
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
