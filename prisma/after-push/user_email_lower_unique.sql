-- Issue #1 6.14.3. REQUIRED unique canonical-email index.
-- @unique User.email alone is case-sensitive. Refuse launch on duplicate
-- case variants or a broken index; never fall back to warning-only startup.
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key"
  ON public."User" (lower(email));

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relname = 'User_email_lower_key'
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND pg_get_expr(i.indexprs, i.indrelid) = 'lower(email)'
  ) THEN
    RAISE EXCEPTION 'billok_user_email_lower_unique_index_missing'
      USING ERRCODE = '23514';
  END IF;
END
$guard$;
