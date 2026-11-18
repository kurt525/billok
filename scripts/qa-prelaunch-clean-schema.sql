-- BillOK 9.4: called only by disposable PostgreSQL CI after a fresh Prisma db push.
-- Reject any inherited objects, while retaining mandatory manual receipts and audit.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(table_name || '.' || column_name, ', ') INTO missing
  FROM information_schema.columns
  WHERE table_schema = 'public' AND (
      (table_name = 'User' AND column_name IN ('defaultCurrency','locale','venmoUsername')) OR
      (table_name = 'Group' AND column_name IN ('simplifyDebts')) OR
      (table_name = 'Expense' AND column_name IN ('category','exchangeRate','baseCurrencyAmount')) OR
      (table_name = 'Settlement' AND column_name IN ('exchangeRate','baseCurrencyAmount')) OR
      (table_name = 'Receipt' AND column_name IN ('imagePath','originalName','mimeType','fileSize')) OR
      (table_name = 'GuestSplit' AND column_name IN ('payerVenmoHandle','receiptShared'))
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Issue 9.4: obsolete columns present: %', missing;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'AdminAction' AND
      e.enumlabel IN ('ORPHANS_CLEANED','MERIDIAN_LOGIN_STARTED','MERIDIAN_LOGIN_COMPLETED',
                      'MERIDIAN_LOGIN_FAILED','MERIDIAN_LOGOUT','MERIDIAN_NOTIFY_PREFERENCE_CHANGED',
                      'AI_PROVIDER_TESTED','VENMO_SETTING_CHANGED','GUEST_UPLOADS_SETTING_CHANGED')
  ) THEN
    RAISE EXCEPTION 'Issue 9.4: obsolete AdminAction values present';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'ReceiptStatus' AND e.enumlabel IN ('PROCESSING','FAILED')
  ) THEN
    RAISE EXCEPTION 'Issue 9.4: obsolete OCR ReceiptStatus present';
  END IF;
  IF to_regclass('public."Receipt"') IS NULL OR
     to_regclass('public."ReceiptItem"') IS NULL OR
     to_regclass('public."ReceiptItemAssignment"') IS NULL OR
     to_regclass('public."AdminAuditLog"') IS NULL OR
     to_regclass('public."OwnerBootstrap"') IS NULL THEN
    RAISE EXCEPTION 'Issue 9.4: required live table missing';
  END IF;
  IF to_regclass('public."ExpenseCategory"') IS NOT NULL OR to_regclass('public."Category"') IS NOT NULL THEN
    RAISE EXCEPTION 'Issue 9.4: obsolete category relation present';
  END IF;
END $$;
SELECT 'BILLOK_94_FRESH_SCHEMA=PASS';
