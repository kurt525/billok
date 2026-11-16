#!/usr/bin/env python3
"""Issue #1 9.3: remove dead image viewers without damaging manual checks.

Prisma columns and the old authenticated upload-file route are NOT deleted
here, because their coordinated schema/SQL removal belongs to Issue #1 9.4.
"""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
ASSIGNMENT = "src/components/receipts/item-assignment.tsx"
CLAIM = "src/app/[locale]/split/[token]/claim/page.tsx"
GUEST = "src/server/trpc/routers/guest.ts"


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


class NoReceiptPhotoViewersTests(unittest.TestCase):
    def test_manual_receipt_editor_no_longer_shows_photo_ui(self):
        component = read(ASSIGNMENT)
        for forbidden in ("showImage", "setZoom", "imageContainerRef", "ImageIcon",
                          "toggleImage", "/api/uploads/", "safeReceipt.imagePath"):
            self.assertNotIn(forbidden, component)
        for retained in ("setManualItemTotalParts", "manualPartsConfirmationSnapshot",
                         "calculateManualReceiptAllocation", "setPersonalTip",
                         "assignItemsAndCreateExpense"):
            self.assertIn(retained, component)

    def test_claim_screen_has_no_photo_at_any_session_stage(self):
        component = read(CLAIM)
        for forbidden in ("receiptImagePath", "toggle-receipt-image",
                          "/api/uploads/", "setShowImage", "ImageIcon"):
            self.assertNotIn(forbidden, component)
        self.assertIn("GuestPaymentGroupsEditor", component)
        self.assertIn("setPersonalTip", component)
        self.assertIn("data-testid=\"copy-link-btn\"", component)

    def test_guest_session_never_discloses_receipt_photo_path(self):
        router = read(GUEST)
        self.assertNotIn("receiptImagePath", router)
        self.assertNotIn("select: { imagePath: true }", router)
        for retained in ("getSession", "getPayerSbpForReimbursement",
                         "setMyPayerSbpContact", "markMyPayment"):
            self.assertIn(retained, router)

    def test_no_abandoned_russian_image_viewer_labels(self):
        expenses = json.loads(read("messages/ru/expenses.json"))
        split = json.loads(read("messages/ru/split.json"))
        for name in ("hideImage", "viewImage", "resetView", "receiptImageAlt"):
            self.assertNotIn(name, expenses["receipt"])
        for name in ("viewReceipt", "hideReceipt", "receiptImage"):
            self.assertNotIn(name, split["claim"])
        self.assertIn("receiptSummary", expenses["receipt"])
        self.assertIn("personalTipSave", split["claim"])

    def test_image_database_cleanup_stays_in_separate_issue_94(self):
        schema = read("prisma/schema.prisma")
        self.assertIn("imagePath", schema)
        self.assertIn("uploadedById", schema)
        self.assertTrue((ROOT / "src/app/api/uploads/[...path]/route.ts").exists())
        self.assertIn("isManual", read("src/server/trpc/routers/receipts.ts"))


if __name__ == "__main__":
    unittest.main()
