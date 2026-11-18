#!/usr/bin/env python3
"""Issue #1 9.3: no unsafe upstream publishing and no abandoned locales.

This test is a scoped safety regression for 9.3. It deliberately does NOT
assert that Venmo APIs, historical currency columns, or receipt fields are
removed; their business dependencies must be handled in later 9.3/9.4 work.
"""
from pathlib import Path
import json
import unittest

ROOT = Path(__file__).resolve().parent.parent
MESSAGES = ROOT / "messages"


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


class DeadApplicationCodeCleanupTests(unittest.TestCase):
    def test_russian_is_the_only_message_catalog(self):
        self.assertEqual(sorted(p.name for p in MESSAGES.iterdir() if p.is_dir()), ["ru"])
        namespaces = sorted(p.stem for p in (MESSAGES / "ru").glob("*.json"))
        self.assertEqual(
            namespaces,
            sorted(("common", "auth", "dashboard", "groups", "expenses",
                    "settings", "admin", "split", "splits", "errors")),
        )
        self.assertIn("locales = ['ru'] as const", source("src/i18n/routing.ts"))
        self.assertNotIn("messages/en", source("src/server/lib/app-error.ts"))

    def test_legacy_money_locales_and_translation_guide_removed(self):
        self.assertFalse((ROOT / "CONTRIBUTING-TRANSLATIONS.md").exists())
        money = source("src/lib/money.ts")
        self.assertIn("Intl.NumberFormat('ru-RU'", money)
        for unsupported in ("en-US", "es-ES", "sv-SE", "fr-FR", "de-DE",
                            "pt-BR", "ja-JP", "zh-CN", "ko-KR"):
            self.assertNotIn(unsupported, money)
        guide = source("CONTRIBUTING.md")
        self.assertIn("BillOK", guide)
        self.assertIn("npm run lint:i18n", guide)
        self.assertNotIn("sharetab.git", guide)

    def test_internal_error_catalog_is_russian_and_safe(self):
        code = source("src/server/lib/app-error.ts")
        self.assertIn("import ru from '../../../messages/ru/errors.json'", code)
        self.assertIn("typeof ru", code)
        self.assertNotIn("englishMessage", code)
        self.assertNotIn("englishGeneric", code)
        self.assertIn("publicErrorKey", code)
        self.assertIn("sessionNotFound", code)
        self.assertIn("splitNotFound", code)

    def test_main_push_and_old_demo_scripts_absent(self):
        scripts = json.loads(source("package.json"))["scripts"]
        for name in ("git:push-main", "push:main", "demo", "demo:gifs"):
            self.assertNotIn(name, scripts)
        self.assertNotIn("scripts/git-push-main.mjs", source("package.json"))
        for name in (
            "scripts/git-push-main.mjs",
            "e2e/demo-video.ts",
            "e2e/demo-gifs.ts",
        ):
            self.assertFalse((ROOT / name).exists(), name)
        self.assertIn("pr:create", scripts, "Keep safe PR creation available")

    def test_redundant_owner_identity_and_unused_environment_helpers_absent(self):
        # 9.3 removes only never-imported modules. The live owner policy
        # and its privileged-route regression suite remain mandatory.
        for dead in (
            "src/server/lib/owner-identity.ts",
            "src/server/lib/owner-identity.test.ts",
            "src/server/lib/env.ts",
        ):
            self.assertFalse((ROOT / dead).exists(), dead)
        policy = source("src/server/lib/owner-access.ts")
        self.assertIn("export async function requireOwner(", policy)
        self.assertIn("db.ownerBootstrap.findUnique({", policy)
        self.assertIn("record?.completedAt", policy)
        self.assertIn("isAllowedRegistrationEmailDomain(user.email)", policy)
        checks = source("src/server/lib/owner-access.test.ts")
        for scenario in (
            "rejects absent sessions before any database lookup",
            "rejects matching email, client owner role and forged identity",
            "rejects missing or incomplete singleton registration",
            "forces EVERY administrative entrypoint through requireOwner",
        ):
            self.assertIn(scenario, checks)

    def test_legacy_profile_currency_and_locale_preferences_removed(self):
        auth = source("src/server/trpc/routers/auth.ts")
        for unused in (
            "defaultCurrency:",
            "locale: true,",
            "locale: z.enum(",
            "locale: user.locale,",
        ):
            self.assertNotIn(unused, auth)
        self.assertIn("sbpPhone: z.string().max(24)", auth)
        self.assertIn("sbpBankId: z.string().max(40)", auth)
        self.assertIn("name: z.string().trim().min(1)", auth)

    def test_rub_balance_paths_do_not_reintroduce_foreign_exchange(self):
        # 9.3 removes runtime FX; Prisma columns are handled only in 9.4.
        for path in (
            "src/server/lib/balance-calculator.ts",
            "src/server/lib/group-balances.ts",
            "src/server/trpc/routers/balances.ts",
            "src/components/groups/payments-list.tsx",
            "src/server/lib/group-expense-totals.ts",
            "src/server/trpc/routers/admin.ts",
            "src/app/[locale]/(app)/groups/[groupId]/page.tsx",
        ):
            self.assertNotIn("baseCurrencyAmount", source(path), path)
        code = source("src/server/lib/balance-calculator.ts")
        self.assertIn("payer.paid += expense.amount", code)
        self.assertIn("member.owes += share.amount", code)
        self.assertIn("from.paid += settlement.amount", code)
        self.assertIn("to.owes += settlement.amount", code)
        tests = source("src/server/lib/balance-calculator.test.ts")
        self.assertIn("one-kopeck debt remains one kopeck", tests)
        self.assertIn("multiple transfers reduce debt by their exact cumulative kopecks", tests)

    def test_rub_writes_do_not_send_legacy_fx_columns(self):
        # Legacy database columns remain until 9.4; never write them in 9.3.
        for path in (
            "src/server/trpc/routers/expenses.ts",
            "src/server/trpc/routers/receipts.ts",
            "src/server/trpc/routers/settlements.ts",
        ):
            content = source(path)
            self.assertNotIn("baseCurrencyAmount", content, path)
            self.assertNotIn("exchangeRate: 1.0", content, path)
            self.assertIn("currency: 'RUB'", content, path)
        self.assertIn("exchangeRate: z.never().optional()", source("src/server/trpc/routers/expenses.ts"))
        self.assertIn("exchangeRate: z.never().optional()", source("src/server/trpc/routers/settlements.ts"))

    def test_package_metadata_and_lock_brand_match(self):
        pkg = json.loads(source("package.json"))
        lock = json.loads(source("package-lock.json"))
        self.assertEqual(pkg["name"], "billok")
        self.assertEqual(lock["name"], "billok")
        self.assertEqual(lock["packages"][""]["name"], "billok")
        self.assertIn("kurt525/billok", pkg["repository"]["url"])

    def test_unreferenced_venmo_settings_ui_removed(self):
        self.assertFalse((ROOT / "src/components/admin/venmo-settings-section.tsx").exists())
        self.assertNotIn(
            "VenmoSettingsSection", source("src/app/[locale]/(app)/admin/page.tsx")
        )


    def test_obsolete_ai_and_external_auth_admin_translations_removed(self):
        admin = json.loads(source("messages/ru/admin.json"))
        for section in (
            "guestUploads", "aiStats", "aiProviderTest", "authExpiry",
            "meridianAuth", "codexAuth",
        ):
            self.assertNotIn(section, admin)
        for required in ("audit", "ownerUsers", "impersonation", "registration"):
            self.assertIn(required, admin)

    def test_unused_legacy_audit_labels_removed_but_security_log_kept(self):
        admin = json.loads(source("messages/ru/admin.json"))
        audit = source("src/components/admin/audit-log-section.tsx")
        for action, key in (
            ("MERIDIAN_LOGIN_STARTED", "actionMeridianLogin"),
            ("MERIDIAN_LOGIN_COMPLETED", "actionMeridianLoggedIn"),
            ("MERIDIAN_LOGIN_FAILED", "actionMeridianLoginFailed"),
            ("MERIDIAN_LOGOUT", "actionMeridianLogout"),
            ("MERIDIAN_NOTIFY_PREFERENCE_CHANGED", "actionNotifyPrefChanged"),
            ("AI_PROVIDER_TESTED", "actionAIProviderTest"),
            ("GUEST_UPLOADS_SETTING_CHANGED", "actionGuestUploadsChanged"),
        ):
            self.assertNotIn(key, admin["audit"])
            self.assertNotIn(action, audit)
        self.assertIn("trpc.admin.getSecurityEvents.useQuery", audit)
        self.assertIn("trpc.admin.getAuditLog.useQuery", audit)
        self.assertIn("label: entry.action", audit)
        for current in ("actionUserDeleted", "actionInviteCreated", "actionExportCreated"):
            self.assertIn(current, admin["audit"])



    def test_unused_currency_selector_and_exchange_rate_screen_are_gone(self):
        self.assertFalse((ROOT / "src/lib/currencies.ts").exists())
        self.assertFalse((ROOT / "src/lib/russian-currency-options.test.ts").exists())
        detail = source("src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/page.tsx")
        for old in ("isCurrencyConverted", "e.baseCurrencyAmount", "e.exchangeRate",
                    "groupCurrency", "detail.exchangeRate"):
            self.assertNotIn(old, detail)
        self.assertIn("formatCents(e.amount, e.currency, locale)", detail)
        self.assertIn("manualExpenseBreakdown", detail)
        self.assertIn("group-finalized-receipt-items", detail)

    def test_old_currency_rate_localization_removed_but_rub_contract_retained(self):
        messages = json.loads(source("messages/ru/expenses.json"))
        for key in ("differentCurrencyNote", "manualRateOverride",
                    "exchangeRatePlaceholder", "convertedAmount", "autoRateNote"):
            self.assertNotIn(key, messages["new"])
        self.assertNotIn("exchangeRate", messages["detail"])
        self.assertIn("rubOnlyLegacyGroup", messages["new"])
        self.assertIn("rubOnlyLegacyExpense", messages["edit"])
        create = source("src/server/trpc/routers/expenses.ts")
        self.assertIn("exchangeRate: z.never().optional()", create)
        self.assertIn("currency: 'RUB'", create)


    def test_upstream_image_endpoints_and_dead_scan_e2e_absent(self):
        for name in (
            "src/app/api/uploads/[...path]/route.ts",
            "src/app/api/uploads/[...path]/route.test.ts",
            "e2e/admin-unused-receipts.spec.ts",
            "e2e/delete-cleanup.spec.ts",
        ):
            self.assertFalse((ROOT / name).exists(), name)
        self.assertNotIn("receiptImagePath", source("src/server/trpc/routers/guest.ts"))
        routes = source("e2e/security.spec.ts")
        self.assertIn("Manual receipt has no image-upload or image-serving API", routes)
        self.assertIn("oldPhoto.headers()['content-type']", routes)

    def test_unused_receipt_loading_animations_removed(self):
        self.assertFalse((ROOT / "src/lib/loading-messages.ts").exists())
        common = json.loads(source("messages/ru/common.json"))
        self.assertNotIn("loadingMessages", common)
        self.assertIn("errors", common)
        self.assertIn("nav", common)


    def test_unsupported_language_switching_e2e_removed(self):
        for name in (
            "e2e/admin-i18n.spec.ts",
            "e2e/i18n.spec.ts",
            "e2e/i18n-errors.spec.ts",
        ):
            self.assertFalse((ROOT / name).exists(), name)
        russian = source("src/i18n/routing.ts")
        self.assertIn("locales = ['ru'] as const", russian)
        for retained in (
            "e2e/billok-mobile-public.spec.ts",
            "e2e/billok-mobile-authenticated.spec.ts",
            "e2e/billok-mobile-guest-split.spec.ts",
            "e2e/billok-passkey-smoke.spec.ts",
        ):
            self.assertTrue((ROOT / retained).exists(), retained)

    def test_playwright_no_longer_selects_missing_upstream_scenarios(self):
        import re
        cfg = source("playwright.config.ts")
        names = re.findall(r"'([A-Za-z0-9-]+[.]spec[.]ts)'", cfg)
        self.assertGreater(len(names), 0)
        self.assertEqual(len(names), 2 * len(set(names)))
        for name in set(names):
            self.assertTrue((ROOT / "e2e" / name).is_file(), name)
        for dead in (
            "admin-i18n.spec.ts",
            "admin-ai-provider-ui.spec.ts",
            "admin-meridian.spec.ts",
            "ai-provider-test.spec.ts",
            "venmo-toggle.spec.ts",
            "venmo-profile.spec.ts",
            "venmo-deeplink.spec.ts",
            "venmo-settle.spec.ts",
            "guest-upload-toggle.spec.ts",
        ):
            self.assertNotIn(dead, cfg)
        self.assertIn("dependencies: ['serial']", cfg)
        self.assertIn("fullyParallel: false", cfg)



    def test_obsolete_photo_browser_scenarios_not_in_test_suite(self):
        for obsolete in ("e2e/receipt-ui.spec.ts",):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)
        self.assertNotIn("receipt-ui.spec.ts", source("playwright.config.ts"))
        forbidden = {
            "e2e/claim-features.spec.ts": ("Claim page — receipt image", "RUN_AI_TESTS", "FAKE_PNG"),
            "e2e/bug-findings.spec.ts": ("Finding #8: non-JSON upload error handling", "/api/upload"),
            "e2e/edge-cases.spec.ts": ("upload generates UUID filename", "/api/upload"),
            "e2e/guest-split.spec.ts": ("Snap a Bill", 'input[type="file"]'),
            "e2e/guest-claim-ui.spec.ts": ("guest-snap-upload", "guest-gallery-upload", "guest-file-input"),
            "e2e/placeholder-ui.spec.ts": ("Pending Receipts UI", "Upload a receipt"),
        }
        for path, markers in forbidden.items():
            content = source(path)
            for marker in markers:
                self.assertNotIn(marker, content, f"{path}: {marker}")
        for retained in (
            "e2e/billok-mobile-receipt-actions.spec.ts",
            "e2e/billok-mobile-guest-split.spec.ts",
            "e2e/billok-passkey-smoke.spec.ts",
            "e2e/security.spec.ts",
        ):
            self.assertTrue((ROOT / retained).exists(), retained)

    def test_name_chip_e2e_uses_manual_receipts_and_passkey(self):
        suite = source("e2e/assignment-chip-names.spec.ts")
        for old in ("/api/upload", "receipts.processReceipt", "guest-file-input", "FAKE_JPEG", "/en/split"):
            self.assertNotIn(old, suite)
        self.assertIn("authedPasskeyContext", suite)
        self.assertIn("create-manual-group-receipt", suite)
        self.assertIn("workflow-manual", suite)
        self.assertIn("e2e/assignment-chip-names.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_split_item_uses_only_manual_receipts_and_signed_passkey(self):
        suite = source("e2e/split-item.spec.ts")
        for marker in ("/api/upload", "FAKE_PNG", "authedContext(", "createTestGroup(", "password123"):
            self.assertNotIn(marker, suite)
        self.assertIn("authedPasskeyContext", suite)
        self.assertIn("receipts.createManual", suite)
        self.assertEqual(suite.count("test('9.3:"), 5)
        self.assertIn("e2e/split-item.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_confirm_dialogs_people_and_splits_migrated(self):
        mobile = source("e2e/confirm-dialogs-people-splits.spec.ts")
        for required in ("authedPasskeyContext", "groups.addPlaceholder", "guest.createSplit",
                         "getByRole('alertdialog')", "currency: 'RUB'"):
            self.assertIn(required, mobile)
        for obsolete in ("/en/", "/api/upload", "receipts.processReceipt", "users.alice.password"):
            self.assertNotIn(obsolete, mobile)
        self.assertEqual(mobile.count("test('9.3:"), 2)
        self.assertIn("e2e/confirm-dialogs-people-splits.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_confirm_dialogs_manual_passkey(self):
        suite = source("e2e/confirm-dialogs-manual.spec.ts")
        for required in ("authedPasskeyContext", "receipts.createManual", "receipts.saveForLater",
                         "receipts.getReceiptItems", "getByRole('alertdialog')"):
            self.assertIn(required, suite)
        for dead in ("/en/", "FAKE_JPEG", "processReceipt", "password"):
            self.assertNotIn(dead, suite)
        self.assertEqual(suite.count("test('9.3:"), 3)
        self.assertIn("e2e/confirm-dialogs-manual.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_obsolete_confirm_dialog_suite_is_replaced_and_signed(self):
        self.assertFalse((ROOT / "e2e/confirm-dialogs.spec.ts").exists())
        last = source("e2e/confirm-dialogs-final.spec.ts")
        for key in ("authedPasskeyContext", "expenses.create", "expenses.get",
                    "guest.createClaimSession", "joinGuestSession", "rememberClaimIdentity",
                    "guest.getSession", "getByRole('alertdialog')", "currency: 'RUB'"):
            self.assertIn(key, last)
        for dead in ("/en/", "FAKE_JPEG", "/api/upload", "receipts.processReceipt", "users.alice.password"):
            self.assertNotIn(dead, last)
        self.assertEqual(last.count("test('9.3:"), 2)
        self.assertIn("e2e/confirm-dialogs-final.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_archive_receipt_only_uses_manual_qa_flow(self):
        self.assertFalse((ROOT / "e2e/groups-archive.spec.ts").exists())
        modern = source("e2e/groups-archive-manual.spec.ts")
        for expected in ("authedPasskeyContext", "receipts.createManual", "receipts.saveForLater",
                         "groups.archive", "groups.unarchive", "receipts.listPending"):
            self.assertIn(expected, modern)
        self.assertEqual(modern.count("test('9.3:"), 4)
        for key in ("groups.listArchived", "groups.joinByInvite", "trpcError",
                    "expenses.create", "currency: 'RUB'"):
            self.assertIn(key, modern)
        self.assertIn("e2e/groups-archive-manual.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_group_archive_legacy_finances_preserved_with_passkey(self):
        self.assertFalse((ROOT / "e2e/groups-archive.spec.ts").exists())
        modern = source("e2e/groups-archive-financial.spec.ts")
        for key in ("authedPasskeyContext", "groups.removeMember", "settlements.create",
                    "expenses.create", "expenses.update", "groups.archive", "currency: 'RUB'",
                    "PRECONDITION_FAILED", "BAD_REQUEST", "trpcError"):
            self.assertIn(key, modern)
        for dead in ("/en/", "/api/upload", "FAKE_JPEG", "users.alice.password", "currency: 'USD'"):
            self.assertNotIn(dead, modern)
        self.assertEqual(modern.count("test('9.3:"), 3)
        self.assertIn("e2e/groups-archive-financial.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_archive_legacy_ui_routes_migrated_to_russian_mobile(self):
        self.assertFalse((ROOT / "e2e/groups-archive.spec.ts").exists())
        modern = source("e2e/groups-archive-ui.spec.ts")
        for key in ("authedPasskeyContext", "mobile-groups-search",
                    "mobile-groups-archived-toggle", "getByRole('alertdialog')",
                    "groups.archive", "Восстановить из архива", "Группа в архиве"):
            self.assertIn(key, modern)
        for dead in ("/en/", "currency: 'USD'", "users.alice.password", "FAKE_JPEG"):
            self.assertNotIn(dead, modern)
        self.assertEqual(modern.count("test('9.3:"), 2)
        self.assertIn("e2e/groups-archive-ui.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_archive_access_ui_replaces_five_obsolete_cases(self):
        self.assertFalse((ROOT / "e2e/groups-archive.spec.ts").exists())
        migrated = source("e2e/groups-archive-access.spec.ts")
        for key in ("authedPasskeyContext", "groups.createInvite", "groups.joinByInvite",
                    "expense-detail-delete", "expense-detail-edit", "groups.archive",
                    "Удалять расход могут только", "Группа в архиве"):
            self.assertIn(key, migrated)
        for dead in ("/en/", "users.alice.password", "currency: 'USD'"):
            self.assertNotIn(dead, migrated)
        self.assertEqual(migrated.count("test('9.3:"), 3)
        self.assertIn("e2e/groups-archive-access.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_archive_admin_impersonation_is_still_signed_and_role_restricted(self):
        self.assertFalse((ROOT / "e2e/groups-archive.spec.ts").exists())
        signed = source("e2e/billok-mobile-authenticated.spec.ts")
        self.assertIn("approveQaOwnerAction(owner, 'IMPERSONATE', targetId)", signed)
        self.assertIn("admin.getImpersonationStatus", signed)
        self.assertIn("e2e/billok-mobile-authenticated.spec.ts", source(".github/workflows/billok-ci.yml"))
        route = source("src/app/api/admin/impersonate/route.ts")
        self.assertIn("approvalToken", route)
        self.assertIn("requireOwner", route)
        active = source("e2e/groups-archive-access.spec.ts")
        self.assertIn("ordinary member", active)
        self.assertIn("getByText('Управление'", active)

    def test_obsolete_password_admin_and_groups_e2e_are_deleted(self):
        for obsolete in ("e2e/admin.spec.ts", "e2e/groups.spec.ts"):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)
            self.assertNotIn(obsolete.split("/")[-1], source("playwright.config.ts"))
        for path, markers in {
            "e2e/billok-mobile-authenticated.spec.ts": (
                "admin.getSystemHealth",
                "admin-groups-search",
                "mobile-groups-create",
                "group-debt-row",
            ),
            "e2e/billok-mobile-guest-split.spec.ts": (
                "'groups.create'",
                "'groups.createInvite'",
            ),
            "e2e/billok-mobile-wide.spec.ts": (
                "'/groups/new'",
            ),
            "e2e/billok-passkey-management-regular.spec.ts": (
                "Owner-only route",
            ),
        }.items():
            content = source(path)
            for marker in markers:
                self.assertIn(marker, content, path)

    def test_obsolete_settlement_and_english_admin_e2e_are_deleted(self):
        for obsolete in ("e2e/balances.spec.ts", "e2e/mobile-admin.spec.ts"):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)
            self.assertNotIn(obsolete.split("/")[-1], source("playwright.config.ts"))
        for filename, markers in {
            "e2e/billok-mobile-authenticated.spec.ts": (
                "group-debt-row",
                "mobile-payment-delete-dialog",
                "admin-groups-search",
                "admin-storage-cleanup-dialog",
                "admin-server-logs",
            ),
            "e2e/billok-owner-passkey-recovery.spec.ts": (
                "owner-users-page",
                "loginWithPasskey",
            ),
        }.items():
            content = source(filename)
            for marker in markers:
                self.assertIn(marker, content, filename)

    def test_obsolete_password_english_mobile_e2e_are_deleted(self):
        for obsolete in (
            "e2e/auth.spec.ts",
            "e2e/mobile.spec.ts",
            "e2e/groups-search.spec.ts",
            "e2e/my-splits.spec.ts",
        ):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)
        current = {
            "e2e/billok-mobile-public.spec.ts": (
                "invited mobile signup waits for email confirmation",
                "/register",
            ),
            "e2e/billok-mobile-auth-journey.spec.ts": (
                "loginWithPasskey",
                "/register",
            ),
            "e2e/billok-mobile-authenticated.spec.ts": (
                "mobile-groups-search",
                "six-width final authenticated mobile adaptation audit across main screens",
            ),
            "e2e/billok-mobile-guest-split.spec.ts": (
                "splits-page",
                "split-card-",
            ),
        }
        for path, markers in current.items():
            content = source(path)
            for marker in markers:
                self.assertIn(marker, content, path)

    def test_obsolete_desktop_and_freeform_settlement_components_are_deleted(self):
        for dead in ("src/components/layout/sidebar.tsx",
                     "src/components/groups/settle-dialog.tsx",
                     "src/components/ui/dropdown-menu.tsx",
                     "src/components/ui/select.tsx",
                     "src/server/lib/normalize-date.ts",
                     "src/server/lib/normalize-date.test.ts",
                     "e2e/sidebar.spec.ts"):
            self.assertFalse((ROOT / dead).exists(), dead)
        layout = source("src/app/[locale]/(app)/layout.tsx")
        self.assertIn("<MobileHeader isAdmin={isAdmin}", layout)
        self.assertNotIn("AppSidebar", layout)
        group = source("src/app/[locale]/(app)/groups/[groupId]/page.tsx")
        self.assertNotIn("<SettleDialog", group)
        self.assertIn("group-debt-row", group)
        self.assertNotIn("sidebar.spec.ts", source("playwright.config.ts"))
        self.assertNotIn("settle-dialog.tsx", source("src/lib/mobile-group-actions.test.ts"))
        self.assertNotIn("sidebar.tsx", source("src/lib/billok-branding.test.ts"))
        self.assertNotIn("normalize-date.ts", source("CLAUDE.md"))

    def test_claim_share_link_no_longer_needs_photo_and_old_locale(self):
        suite = source("e2e/claim-share-link.spec.ts")
        for obsolete in ("guest-file-input", "scan-file-input", "test-receipt.png", "/en/", "FAKE_PNG", "FAKE_JPEG"):
            self.assertNotIn(obsolete, suite)
        self.assertFalse((ROOT / "e2e/test-receipt.png").exists())
        self.assertIn("authedPasskeyContext", suite)
        self.assertIn("receipts.createManual", suite)
        self.assertIn("workflow-manual", suite)
        self.assertEqual(suite.count("test('9.3:"), 3)
        self.assertIn("e2e/claim-share-link.spec.ts", source(".github/workflows/billok-ci.yml"))

    def test_only_russian_internal_locale_rewrite_remains(self):
        paths = source("src/lib/locale-paths.ts")
        middleware = source("src/middleware.ts")
        for obsolete in ("legacyLocales", "hasLocalePrefix", "withLocalePrefix",
                         "'en', 'es'", "Migrate links generated by upstream ShareTab"):
            self.assertNotIn(obsolete, paths + middleware)
        self.assertIn("pathname !== '/ru' && !pathname.startsWith('/ru/')", paths)
        self.assertIn("stripLocalePrefix(pathname)", middleware)
        self.assertIn("internalRussianPath ? NextResponse.next()", middleware)
        self.assertNotIn("NextResponse.redirect(url, 308)", middleware)
        self.assertIn("trustedApiMutation", middleware)
        self.assertIn("getToken", middleware)

    def test_passkey_login_and_registration_use_safe_canonical_callbacks(self):
        paths = source("src/lib/locale-paths.ts")
        self.assertIn("if (!isSafeInternalPath(rawCallbackUrl)) return '/dashboard'", paths)
        self.assertIn("const canonical = stripLocalePrefix(rawCallbackUrl)", paths)
        self.assertIn("return '/dashboard'", paths)
        login = source("src/app/[locale]/(auth)/login/page.tsx")
        registration = source("src/app/[locale]/(auth)/register/page.tsx")
        for component in (login, registration):
            self.assertIn("normalizeCallbackPath(", component)
            self.assertNotIn("useLocale()", component)
        self.assertIn("signOut({ callbackUrl: '/login' })", login)
        self.assertIn("startAuthentication", login)
        self.assertIn("signIn('passkey'", login)
        self.assertIn("registerMutation.mutateAsync", registration)



    def test_dashboard_uses_only_rubles_without_legacy_mixed_currency_branch(self):
        dashboard = source("src/app/[locale]/(app)/dashboard/page.tsx")
        messages = json.loads(source("messages/ru/dashboard.json"))
        for removed in ("hasMixedCurrencies", "groupCurrencies", "aggregateCurrency",
                        "mixedCurrencies", "mixedCurrenciesDebts", "balance.currency", "g.currency"):
            self.assertNotIn(removed, dashboard)
        self.assertNotIn("mixedCurrencies", messages)
        self.assertNotIn("mixedCurrenciesDebts", messages)
        self.assertEqual(dashboard.count("formatCents("), 6)
        self.assertEqual(dashboard.count("'RUB', locale)"), 6)
        self.assertIn("overallDebts.data?.owedToYou.map", dashboard)
        self.assertIn("overallDebts.data?.youOwe.map", dashboard)
        self.assertIn("dashboard.data.totalOwed", dashboard)
        self.assertIn("dashboard.data.totalOwing", dashboard)

    def test_sharetab_demo_and_unused_ocr_fixtures_absent(self):
        self.assertFalse((ROOT / "e2e/generate-receipt-images.mjs").exists())
        self.assertFalse(any((ROOT / "demo").glob("*.gif")))
        self.assertFalse((ROOT / "demo/social-preview.png").exists())
        for obsolete in (
            "e2e/receipts/coffee-shop.png",
            "e2e/guest-claiming-ui.spec.ts",
            "e2e/guest-split-item-ui.spec.ts",
            "e2e/save-for-later.spec.ts",
            "e2e/split-item-ui.spec.ts",
            "e2e/api-receipt-editing.spec.ts",
        ):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)


if __name__ == "__main__":
    unittest.main()
