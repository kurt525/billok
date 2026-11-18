#!/usr/bin/env python3
"""Issue #1 9.4: validate User field removal without accessing any live database."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent


class UserSchemaCleanupTests(unittest.TestCase):
    def test_user_has_no_currency_or_locale_column(self):
        schema = (ROOT / "prisma/schema.prisma").read_text(encoding="utf-8")
        user = schema.split("model User {", 1)[1].split("\n}", 1)[0]
        for obsolete in ("defaultCurrency", "locale"):
            self.assertNotRegex(user, r"(?m)^\s*" + obsolete + r"\s+")
        for required in ("email", "emailVerified", "sessionSecurityVersion",
                         "registrationEmailVerificationRequired", "webAuthnUserHandle",
                         "sbpPhone", "sbpBankId"):
            self.assertRegex(user, r"(?m)^\s*" + required + r"\s+")

    def test_sql_migration_only_drops_two_user_columns_and_is_idempotent(self):
        migration = (ROOT / "prisma/migrations/user_currency_locale_drop.sql").read_text(encoding="utf-8")
        self.assertIn('ALTER TABLE IF EXISTS "User"', migration)
        self.assertIn('DROP COLUMN IF EXISTS "defaultCurrency"', migration)
        self.assertIn('DROP COLUMN IF EXISTS "locale"', migration)
        self.assertEqual(len(re.findall(r"DROP COLUMN", migration)), 2)
        self.assertNotIn("DROP TABLE", migration)
        self.assertNotIn("CASCADE", migration.upper())

    def test_owner_bootstrap_does_not_write_removed_fields(self):
        bootstrap = (ROOT / "src/server/lib/owner-bootstrap.ts").read_text(encoding="utf-8")
        self.assertNotIn("locale: 'ru'", bootstrap)
        self.assertIn("registrationEmailVerificationRequired: true", bootstrap)
        self.assertIn("createInitialOwner(", bootstrap)


if __name__ == "__main__":
    unittest.main()
