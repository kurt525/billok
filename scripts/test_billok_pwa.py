"""Dependency-free CI checks for the BillOK mobile PWA foundation.

These checks deliberately run as a separate GitHub Actions job, without a
second Node.js dependency installation just to parse the PWA manifest.
"""

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "public/manifest.json").read_text(encoding="utf-8"))
LAYOUT = (ROOT / "src/app/[locale]/layout.tsx").read_text(encoding="utf-8")


class BillokMobilePWATests(unittest.TestCase):
    def test_branding(self):
        self.assertEqual(MANIFEST["name"], "BillOK")
        self.assertEqual(MANIFEST["short_name"], "BillOK")
        self.assertIn("title: 'BillOK'", LAYOUT)
        self.assertIn("applicationName: 'BillOK'", LAYOUT)

    def test_install_identity(self):
        self.assertEqual(MANIFEST["id"], "/")
        self.assertEqual(MANIFEST["start_url"], "/")
        self.assertEqual(MANIFEST["scope"], "/")
        self.assertEqual(MANIFEST["lang"], "ru-RU")

    def test_mobile_app_display(self):
        self.assertEqual(MANIFEST["display"], "standalone")
        self.assertEqual(MANIFEST["orientation"], "portrait-primary")
        self.assertIn("viewportFit: 'cover'", LAYOUT)
        self.assertIn("interactiveWidget: 'resizes-content'", LAYOUT)
        self.assertNotIn("maximumScale:", LAYOUT)

    def test_icons_exist(self):
        icons = MANIFEST["icons"]
        self.assertTrue(icons)
        sizes = set()
        for icon in icons:
            self.assertTrue(icon["src"].startswith("/icons/"))
            self.assertTrue((ROOT / "public" / icon["src"].lstrip("/")).is_file())
            self.assertEqual(icon["type"], "image/png")
            sizes.add(icon["sizes"])
        self.assertTrue({"192x192", "512x512"}.issubset(sizes))


if __name__ == "__main__":
    unittest.main()
