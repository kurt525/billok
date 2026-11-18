-- BillOK Issue #1 9.4: prelaunch legacy schema cleanup.
-- Invoke only on an isolated BillOK development/QA database before Prisma sync.
-- Idempotent on new/test-only databases; Prisma schema is the source of truth.

-- BEGIN category
-- BillOK prelaunch cleanup: expense categories were only ever test data.
-- Safe both before a fresh prisma db push and on an existing test database.
ALTER TABLE IF EXISTS "Expense" DROP COLUMN IF EXISTS "category";
-- END category

-- BEGIN currency
-- Issue #1 9.4: obsolete User currency/language preferences are not part of BillOK.
-- Idempotent on a pristine install (before Prisma db push) and on old test-only installations.
-- Never touches other projects' databases.
ALTER TABLE IF EXISTS "User"
  DROP COLUMN IF EXISTS "defaultCurrency",
  DROP COLUMN IF EXISTS "locale";
-- END currency

-- BEGIN venmo_fx
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
-- END venmo_fx

-- BEGIN receipt_media
-- Issue #1 9.4 stage B: manual receipts have no photo, OCR or image-share column.
-- Idempotent on an old test-only BillOK database or a fresh Prisma schema.
ALTER TABLE IF EXISTS "Receipt"
  DROP COLUMN IF EXISTS "imagePath",
  DROP COLUMN IF EXISTS "originalName",
  DROP COLUMN IF EXISTS "mimeType",
  DROP COLUMN IF EXISTS "fileSize";
ALTER TABLE IF EXISTS "GuestSplit"
  DROP COLUMN IF EXISTS "receiptShared";

-- ReceiptStatus has two valid manual-only states: draft and finalized.
-- If an old test database has OCR states, normalize them before replacing the enum.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'ReceiptStatus'
      AND e.enumlabel IN ('PROCESSING', 'FAILED')
  ) THEN
    UPDATE "Receipt" SET "status" = 'PENDING'
      WHERE "status"::text IN ('PROCESSING', 'FAILED');
    ALTER TABLE "Receipt" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TYPE "ReceiptStatus" RENAME TO "ReceiptStatus_legacy";
    CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'COMPLETED');
    ALTER TABLE "Receipt" ALTER COLUMN "status"
      TYPE "ReceiptStatus" USING "status"::text::"ReceiptStatus";
    ALTER TABLE "Receipt" ALTER COLUMN "status" SET DEFAULT 'PENDING';
    DROP TYPE "ReceiptStatus_legacy";
  END IF;
END $$;
-- END receipt_media

-- BEGIN last_unused_group_column
ALTER TABLE IF EXISTS "Group" DROP COLUMN IF EXISTS "simplifyDebts";
-- END last_unused_group_column

-- BEGIN retired_admin_actions
-- Pre-release test audit rows for retired actions are discarded, never relabeled.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'AdminAction' AND e.enumlabel IN (
      'ORPHANS_CLEANED',
      'MERIDIAN_LOGIN_STARTED',
      'MERIDIAN_LOGIN_COMPLETED',
      'MERIDIAN_LOGIN_FAILED',
      'MERIDIAN_LOGOUT',
      'MERIDIAN_NOTIFY_PREFERENCE_CHANGED',
      'AI_PROVIDER_TESTED',
      'VENMO_SETTING_CHANGED',
      'GUEST_UPLOADS_SETTING_CHANGED'
    )
  ) THEN
    IF to_regclass('public."AdminAuditLog"') IS NOT NULL THEN
      DELETE FROM "AdminAuditLog" WHERE "action"::text IN (
        'ORPHANS_CLEANED',
        'MERIDIAN_LOGIN_STARTED',
        'MERIDIAN_LOGIN_COMPLETED',
        'MERIDIAN_LOGIN_FAILED',
        'MERIDIAN_LOGOUT',
        'MERIDIAN_NOTIFY_PREFERENCE_CHANGED',
        'AI_PROVIDER_TESTED',
        'VENMO_SETTING_CHANGED',
        'GUEST_UPLOADS_SETTING_CHANGED'
      );
      ALTER TABLE "AdminAuditLog" ALTER COLUMN "action" DROP DEFAULT;
    END IF;
    ALTER TYPE "AdminAction" RENAME TO "AdminAction_legacy";
    CREATE TYPE "AdminAction" AS ENUM (
      'USER_DELETED',
      'USER_SUSPENDED',
      'USER_UNSUSPENDED',
      'GROUP_DELETED',
      'IMPERSONATION_STARTED',
      'IMPERSONATION_ENDED',
      'OWNER_BOOTSTRAP_STARTED',
      'OWNER_BOOTSTRAP_EMAIL_SENT',
      'OWNER_BOOTSTRAP_COMPLETED',
      'OWNER_PASSKEY_RECOVERY_REQUESTED',
      'PASSKEY_RECOVERY_COMPLETED',
      'OWNER_PASSKEY_REVOKED',
      'OWNER_PASSKEY_ADDED',
      'OWNER_PASSKEY_RENAMED',
      'OWNER_PASSKEY_APPROVAL_VERIFIED',
      'INVITE_CREATED',
      'INVITE_REVOKED',
      'ANNOUNCEMENT_SET',
      'REGISTRATION_MODE_CHANGED',
      'EXPORT_CREATED',
      'TEST_EMAIL_SENT',
      'EXPIRED_SPLITS_CLEANED',
      'UNUSED_RECEIPTS_CLEANED'
    );
    IF to_regclass('public."AdminAuditLog"') IS NOT NULL THEN
      ALTER TABLE "AdminAuditLog" ALTER COLUMN "action"
        TYPE "AdminAction" USING "action"::text::"AdminAction";
    END IF;
    DROP TYPE "AdminAction_legacy";
  END IF;
END $$;
-- END retired_admin_actions
