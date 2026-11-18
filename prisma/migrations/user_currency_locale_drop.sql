-- Issue #1 9.4: obsolete User currency/language preferences are not part of BillOK.
-- Idempotent on a pristine install (before Prisma db push) and on old test-only installations.
-- Never touches other projects' databases.
ALTER TABLE IF EXISTS "User"
  DROP COLUMN IF EXISTS "defaultCurrency",
  DROP COLUMN IF EXISTS "locale";
