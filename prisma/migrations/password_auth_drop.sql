-- BillOK prelaunch passwordless cutover, Issue #1 6.3.2.3.
-- Removes test-only password credentials and their reset tokens.
DROP TABLE IF EXISTS "PasswordResetRequest";
ALTER TABLE IF EXISTS "User" DROP COLUMN IF EXISTS "passwordHash";
