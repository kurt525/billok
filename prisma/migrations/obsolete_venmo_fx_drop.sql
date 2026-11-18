-- Issue #1 9.4, stage A: legacy Venmo and FX database fields.
-- Safe on new schema or old test-only BillOK database; never touches other databases.
ALTER TABLE IF EXISTS "User" DROP COLUMN IF EXISTS "venmoUsername";
ALTER TABLE IF EXISTS "GuestSplit" DROP COLUMN IF EXISTS "payerVenmoHandle";
ALTER TABLE IF EXISTS "Expense"
  DROP COLUMN IF EXISTS "exchangeRate",
  DROP COLUMN IF EXISTS "baseCurrencyAmount";
ALTER TABLE IF EXISTS "Settlement"
  DROP COLUMN IF EXISTS "exchangeRate",
  DROP COLUMN IF EXISTS "baseCurrencyAmount";
