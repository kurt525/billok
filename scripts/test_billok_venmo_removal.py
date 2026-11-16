#!/usr/bin/env python3
"""Issue #1 9.3: reject residual external Venmo payment/identity paths.

The old Prisma model fields and audit enum are reserved for the independent
schema cleanup in 9.4; this test checks the actual running application.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


class VenmoRemovedTests(unittest.TestCase):
    def test_no_live_venmo_routes_or_external_payment_utility(self):
        self.assertFalse((ROOT / "src/lib/venmo.ts").exists())
        for path in (ROOT / "src").rglob("*"):
            if not path.is_file() or path.suffix not in (".ts", ".tsx"):
                continue
            if "generated" in path.parts or ".test." in path.name:
                continue
            content = path.read_text(encoding="utf-8")
            self.assertNotIn("venmo", content.lower(), str(path.relative_to(ROOT)))

    def test_no_venmo_e2e_coverage_or_dead_payment_buttons(self):
        self.assertEqual(
            [p.name for p in (ROOT / "e2e").glob("*venmo*")],
            [],
        )
        for p in (
            "src/app/[locale]/(app)/groups/[groupId]/page.tsx",
            "src/app/[locale]/split/[token]/page.tsx",
            "src/app/[locale]/split/[token]/claim/page.tsx",
        ):
            self.assertNotIn("venmo", (ROOT / p).read_text().lower())

    def test_no_russian_venmo_translations(self):
        for jsonfile in (ROOT / "messages/ru").glob("*.json"):
            self.assertNotIn("venmo", jsonfile.read_text().lower(), str(jsonfile))

    def test_retained_russian_sbp_payment_flows(self):
        guest = (ROOT / "src/server/trpc/routers/guest.ts").read_text()
        self.assertIn("getPayerSbpForReimbursement", guest)
        self.assertIn("setMyPayerSbpContact", guest)
        self.assertIn("markMyPayment", guest)
        auth = (ROOT / "src/server/trpc/routers/auth.ts").read_text()
        self.assertIn("sbpPhone", auth)
        self.assertIn("sbpBankId", auth)

    def test_no_legacy_balance_payment_destination_output(self):
        balances = (ROOT / "src/server/trpc/routers/balances.ts").read_text().lower()
        self.assertNotIn("venmo", balances)
        self.assertIn("getoverallDebts".lower(), balances)
        self.assertIn("getDashboard".lower(), balances)


if __name__ == "__main__":
    unittest.main()
