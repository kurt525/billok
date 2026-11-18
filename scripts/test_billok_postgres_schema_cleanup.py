#!/usr/bin/env python3
"""Issue #1 9.4: validate User field removal without accessing any live database."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent

CLEANUP_SQL = ROOT / "prisma/migrations/prelaunch_schema_cleanup.sql"


def cleanup_section(name: str) -> str:
    full = CLEANUP_SQL.read_text(encoding="utf-8")
    return full.split("-- BEGIN " + name + "\n", 1)[1].split("-- END " + name, 1)[0]


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
        migration = cleanup_section("currency")
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
        sql = cleanup_section("venmo_fx")
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

    def test_manual_receipt_media_and_ocr_columns_are_gone(self):
        schema = (ROOT / "prisma/schema.prisma").read_text(encoding="utf-8")
        receipt = schema.split("model Receipt {", 1)[1].split("\n}", 1)[0]
        split = schema.split("model GuestSplit {", 1)[1].split("\n}", 1)[0]
        for obsolete in ("imagePath", "originalName", "mimeType", "fileSize"):
            self.assertNotRegex(receipt, r"(?m)^\s*" + obsolete + r"\s+")
        self.assertNotRegex(split, r"(?m)^\s*receiptShared\s+")
        for required in ("uploadedById", "savedById", "paidById", "groupId",
                         "extractedData", "status", "items"):
            self.assertRegex(receipt, r"(?m)^\s*" + required + r"\s+")
        statuses = schema.split("enum ReceiptStatus {", 1)[1].split("\n}", 1)[0]
        self.assertIn("PENDING", statuses)
        self.assertIn("COMPLETED", statuses)
        self.assertNotIn("PROCESSING", statuses)
        self.assertNotIn("FAILED", statuses)

    def test_manual_receipt_schema_migration_restricts_changes_to_billok(self):
        sql = cleanup_section("receipt_media")
        self.assertEqual(sql.count("DROP COLUMN IF EXISTS"), 5)
        for column in ("imagePath", "originalName", "mimeType", "fileSize", "receiptShared"):
            self.assertIn('DROP COLUMN IF EXISTS "' + column + '"', sql)
        self.assertIn('ALTER TABLE IF EXISTS "Receipt"', sql)
        self.assertIn('ALTER TABLE IF EXISTS "GuestSplit"', sql)
        self.assertIn('ALTER TYPE "ReceiptStatus" RENAME TO "ReceiptStatus_legacy"', sql)
        self.assertIn("WHERE t.typname = 'ReceiptStatus'", sql)
        self.assertNotIn("CASCADE", sql.upper())

    def test_manual_receipt_security_and_row_lock_remain(self):
        router = (ROOT / "src/server/trpc/routers/receipts.ts").read_text(encoding="utf-8")
        self.assertNotIn("originalName", router)
        self.assertIn("uploadedById !== ctx.user.id", router)
        self.assertIn("FOR UPDATE", router)
        self.assertIn("manualPartsConfirmationSnapshot", router)
        self.assertIn("receiptPartsConfirmationRequired", router)
        self.assertIn("calculateManualReceiptTotals(", router)

    def test_retired_admin_audit_actions_are_removed_but_ongoing_audit_survives(self):
        schema = (ROOT / "prisma/schema.prisma").read_text(encoding="utf-8")
        values = schema.split("enum AdminAction {", 1)[1].split("\n}", 1)[0]
        retired = (
            "ORPHANS_CLEANED", "MERIDIAN_LOGIN_STARTED", "MERIDIAN_LOGIN_COMPLETED",
            "MERIDIAN_LOGIN_FAILED", "MERIDIAN_LOGOUT", "MERIDIAN_NOTIFY_PREFERENCE_CHANGED",
            "AI_PROVIDER_TESTED", "VENMO_SETTING_CHANGED", "GUEST_UPLOADS_SETTING_CHANGED",
        )
        for item in retired:
            self.assertNotRegex(values, r"(?m)^\s*" + item + r"\s*$")
        for required in ("OWNER_BOOTSTRAP_COMPLETED", "OWNER_PASSKEY_REVOKED",
                         "OWNER_PASSKEY_ADDED", "OWNER_PASSKEY_APPROVAL_VERIFIED",
                         "INVITE_CREATED", "EXPORT_CREATED", "UNUSED_RECEIPTS_CLEANED",
                         "IMPERSONATION_STARTED"):
            self.assertRegex(values, r"(?m)^\s*" + required + r"\s*$")
        sql = cleanup_section("retired_admin_actions")
        for retired_action in retired:
            self.assertIn("'" + retired_action + "'", sql)
        for action in ("OWNER_PASSKEY_ADDED", "UNUSED_RECEIPTS_CLEANED"):
            self.assertIn("'" + action + "'", sql)
        self.assertIn('ALTER TABLE "AdminAuditLog" ALTER COLUMN "action"', sql)
        self.assertIn('ALTER TYPE "AdminAction" RENAME TO "AdminAction_legacy"', sql)
        self.assertNotIn("CASCADE", sql.upper())

    def test_unused_group_setting_not_recreated_but_live_balances_are_retained(self):
        schema = (ROOT / "prisma/schema.prisma").read_text(encoding="utf-8")
        group = schema.split("model Group {", 1)[1].split("\n}", 1)[0]
        self.assertNotRegex(group, r"(?m)^\s*simplifyDebts\s+")
        self.assertIn('DROP COLUMN IF EXISTS "simplifyDebts"', cleanup_section("last_unused_group_column"))
        self.assertNotIn("simplifyDebts: z.boolean()", (ROOT / "src/server/trpc/routers/groups.ts").read_text())
        self.assertIn("simplifyDebts(", (ROOT / "src/server/trpc/routers/balances.ts").read_text())
        self.assertIn("image", schema, "User.image is still consumed by active session/UI")

    def test_legacy_migrations_are_consolidated_but_security_migrations_retained(self):
        for old in ("expense_category_drop.sql", "user_currency_locale_drop.sql",
                    "obsolete_venmo_fx_drop.sql", "obsolete_receipt_media_drop.sql"):
            self.assertFalse((ROOT / "prisma/migrations" / old).exists())
        self.assertIn('DROP COLUMN IF EXISTS "category"', cleanup_section("category"))
        self.assertIn("prelaunch_schema_cleanup.sql", (ROOT / "scripts/dev.mjs").read_text())
        self.assertTrue((ROOT / "prisma/migrations/password_auth_drop.sql").exists())
        self.assertTrue((ROOT / "prisma/after-push/user_email_ru_su_guard.sql").exists())
        self.assertTrue((ROOT / "prisma/after-push/owner_bootstrap_identity_guard.sql").exists())

    def test_clean_database_catalog_guard_is_connected_to_CI(self):
        guard = ROOT / "scripts/qa-prelaunch-clean-schema.sql"
        sql = guard.read_text(encoding="utf-8")
        for name in ("AdminAction", "Group", "Expense", "User", "Receipt", "GuestSplit"):
            self.assertIn(name, sql)
        self.assertIn("RAISE EXCEPTION", sql)
        ci = (ROOT / ".github/workflows/billok-ci.yml").read_text(encoding="utf-8")
        self.assertIn("qa-prelaunch-clean-schema.sql", ci)
        self.assertIn("prelaunch_schema_cleanup.sql", ci)

    def test_owner_bootstrap_does_not_write_removed_fields(self):
        bootstrap = (ROOT / "src/server/lib/owner-bootstrap.ts").read_text(encoding="utf-8")
        self.assertNotIn("locale: 'ru'", bootstrap)
        self.assertIn("registrationEmailVerificationRequired: true", bootstrap)
        self.assertIn("createInitialOwner(", bootstrap)


if __name__ == "__main__":
    unittest.main()
