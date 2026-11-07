-- BillOK prelaunch cleanup: expense categories were only ever test data.
-- Safe both before a fresh prisma db push and on an existing test database.
-- The Docker entrypoint applies all files here before Prisma schema sync.
ALTER TABLE IF EXISTS "Expense" DROP COLUMN IF EXISTS "category";
