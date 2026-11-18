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

    def test_old_venmo_and_fx_fields_are_absent_from_prisma_schema(self):
        schema = (ROOT / "prisma/schema.prisma").read_text(encoding="utf-8")
        fields = {
            "User": ("venmoUsername",),
            "GuestSplit": ("payerVenmoHandle",),
            "Expense": ("exchangeRate", "baseCurrencyAmount"),
            "Settlement": ("exchangeRate", "baseCurrencyAmount"),
        }
        for model, obsolete in fields.items():
            model_body = schema.split("model " + model + " {", 1)[1].split("\n}", 1)[0]
            for field in obsolete:
                self.assertNotRegex(model_body, r"(?m)^\s*" + field + r"\s+")
        for model in ("Expense", "Settlement"):
            body = schema.split("model " + model + " {", 1)[1].split("\n}", 1)[0]
            self.assertRegex(body, r"(?m)^\s*amount\s+Int\s+")
            self.assertRegex(body, r"(?m)^\s*currency\s+String\s+@default\(\"RUB\"\)")

    def test_venmo_fx_migration_drops_only_six_columns_and_is_repeatable(self):
        path = ROOT / "prisma/migrations/obsolete_venmo_fx_drop.sql"
        sql = path.read_text(encoding="utf-8")
        for table in ("User", "GuestSplit", "Expense", "Settlement"):
            self.assertIn('ALTER TABLE IF EXISTS "' + table + '"', sql)
        for field in ("venmoUsername", "payerVenmoHandle", "exchangeRate", "baseCurrencyAmount"):
            self.assertIn('DROP COLUMN IF EXISTS "' + field + '"', sql)
        self.assertEqual(sql.count('DROP COLUMN IF EXISTS'), 6)
        self.assertNotIn("CASCADE", sql.upper())
        self.assertNotIn("DROP TABLE", sql.upper())

    def test_prohibit_fx_and_keep_mobile_api_guard(self):
        for path in ("src/server/trpc/routers/expenses.ts",
                     "src/server/trpc/routers/settlements.ts"):
            content = (ROOT / path).read_text(encoding="utf-8")
            self.assertIn("exchangeRate: z.never().optional()", content)
        for path in ("src/server/trpc/routers/expenses.test.ts",
                     "src/server/trpc/routers/groups.test.ts",
                     "src/server/trpc/routers/settlements.test.ts",
                     "e2e/billok-mobile-authenticated.spec.ts"):
            content = (ROOT / path).read_text(encoding="utf-8")
            self.assertNotIn("baseCurrencyAmount: null", content, path)

    def test_owner_bootstrap_does_not_write_removed_fields(self):
        bootstrap = (ROOT / "src/server/lib/owner-bootstrap.ts").read_text(encoding="utf-8")
        self.assertNotIn("locale: 'ru'", bootstrap)
        self.assertIn("registrationEmailVerificationRequired: true", bootstrap)
        self.assertIn("createInitialOwner(", bootstrap)


if __name__ == "__main__":
    unittest.main()
