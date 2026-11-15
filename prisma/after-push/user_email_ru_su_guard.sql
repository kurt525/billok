-- Issue #1 6.14.3. Mandatory, fail-closed PostgreSQL User.email guard.
-- Runs AFTER prisma db push, twice in disposable CI. Existing bad rows
-- BLOCK installation: never backfill, wipe, or bypass a working database.
-- ASCII addr-spec, A-label DNS and last TLD .ru/.su only. The shared
-- application normalizer additionally validates IDNA Punycode semantics.
CREATE OR REPLACE FUNCTION public.billok_user_email_ru_su_allowed(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $guard$
DECLARE
  at_pos integer;
  local_part text;
  host_part text;
  labels text[];
  label text;
  count_labels integer;
BEGIN
  IF length(value) < 5 OR length(value) > 254
     OR value COLLATE "C" !~ '^[!-~]+$' THEN
    RETURN false;
  END IF;
  at_pos := strpos(value, '@');
  IF at_pos < 2 OR at_pos <> length(value) - strpos(reverse(value), '@') + 1 THEN
    RETURN false;
  END IF;
  local_part := substring(value FROM 1 FOR at_pos - 1);
  host_part := substring(value FROM at_pos + 1);
  IF length(local_part) > 64 OR host_part = '' OR length(host_part) > 253
    OR local_part COLLATE "C" !~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~.-]+$'
    OR left(local_part, 1) = '.' OR right(local_part, 1) = '.'
    OR strpos(local_part, '..') > 0 THEN
    RETURN false;
  END IF;
  labels := string_to_array(host_part, '.');
  count_labels := array_length(labels, 1);
  IF count_labels IS NULL OR count_labels < 2
     OR lower(labels[count_labels] COLLATE "C") NOT IN ('ru', 'su') THEN
    RETURN false;
  END IF;
  FOR label IN SELECT unnest(labels) LOOP
    IF label IS NULL OR length(label) = 0 OR length(label) > 63
       OR label COLLATE "C" !~ '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$'
       OR (substring(label FROM 3 FOR 2) = '--'
           AND left(lower(label COLLATE "C"), 4) <> 'xn--')
       OR (left(lower(label COLLATE "C"), 4) = 'xn--' AND length(label) < 6)
    THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END
$guard$;

-- Validated CHECK protects SQL/Prisma/seed/imports even if middleware fails.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public."User"'::regclass
      AND conname = 'billok_user_email_ru_su_check'
      AND contype = 'c' AND convalidated
  ) THEN
    ALTER TABLE public."User"
      ADD CONSTRAINT billok_user_email_ru_su_check
      CHECK (public.billok_user_email_ru_su_allowed(email));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."User"
    WHERE NOT public.billok_user_email_ru_su_allowed(email)
  ) THEN
    RAISE EXCEPTION 'billok_user_email_ru_su_preexisting_invalid'
      USING ERRCODE = '23514';
  END IF;
END
$guard$;
