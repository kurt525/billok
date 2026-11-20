-- Issue #1 3.25.2.3: protect every personal bearer in GuestSplit.people.
-- A CHECK verifies format even on direct SQL/Prisma writes; the application
-- validates AES-256-GCM tags and binds each ciphertext to its personId.
-- Idempotent after Prisma db push. Old test-only UUID bearer rows must be
-- cleared before the first deployment; there are no production guest rows.
CREATE OR REPLACE FUNCTION public.billok_guest_person_tokens_sealed(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  entry jsonb;
  token text;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(payload) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
    IF entry ? 'personToken' THEN
      IF jsonb_typeof(entry -> 'personToken') IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
      token := entry ->> 'personToken';
      IF token !~ '^v1[.][A-Za-z0-9_-]{95}$' THEN RETURN FALSE; END IF;
      IF (entry ->> 'id') IS NULL OR
         (entry ->> 'id') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
        RETURN FALSE;
      END IF;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public."GuestSplit"'::regclass
       AND conname = 'guest_person_link_storage_format'
  ) THEN
    ALTER TABLE public."GuestSplit" ADD CONSTRAINT guest_person_link_storage_format
      CHECK (public.billok_guest_person_tokens_sealed(people));
  END IF;
END
$guard$;
