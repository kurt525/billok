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


if __name__ == "__main__":
    unittest.main()
