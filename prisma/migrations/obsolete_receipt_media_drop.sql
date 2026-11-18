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
