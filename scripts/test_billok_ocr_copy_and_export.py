#!/usr/bin/env python3
"""Issue #1 9.3: legacy OCR messages and file metadata must not leak.

The schema columns and receipt cleanup services remain until Issue #1 9.4.
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def source(name):
    return (ROOT / name).read_text(encoding="utf8")


def catalog(name):
    return json.loads(source("messages/ru/" + name + ".json"))


class ObsoleteReceiptMediaCleanupTests(unittest.TestCase):
    def test_manual_split_keeps_title_but_not_camera_and_ocr_ui(self):
        split = catalog("split")
        self.assertEqual(set(split["upload"]), {"title"})
        self.assertNotIn("processing", split)
        for key in ("rescanCorrections", "rescanDescription", "rescanPlaceholder", "rescan"):
            self.assertNotIn(key, split["people"])
        for key in ("hideReceipt", "viewReceipt", "receiptImageAlt",
                    "tipOverrideLabel", "tipDetected"):
            self.assertNotIn(key, split["assign"])
        self.assertIn("receiptSummary", split["assign"])
        self.assertIn("whoPaid", split["people"])

    def test_manual_group_editor_keeps_real_messages_only(self):
        d = catalog("expenses")["scan"]
        for key in ("title", "upload", "uploadDescription", "receiptImage",
                    "processing", "retryProcessing", "rescanCorrections",
                    "rescanDescription", "rescanPlaceholder", "rescan",
                    "uploading", "uploadFailed"):
            self.assertNotIn(key, d)
        for required in ("manualTitle", "savedReceiptTitle", "shareForClaiming",
                         "creatingSession", "loadingGroup", "groupLoadError",
                         "createSessionFailed"):
            self.assertIn(required, d)

    def test_dead_ocr_and_old_currency_errors_not_returned(self):
        errors = catalog("errors")
        for key in ("receiptBeingProcessed", "receiptProcessingFailed",
                    "reprocessingFailed", "processingRateLimited",
                    "guestUploadsDisabled", "guestUploadsLockedOff",
                    "uploadsRateLimited", "testImageTooLarge",
                    "exchangeRateUnavailable", "receiptExchangeRateUnavailable"):
            self.assertNotIn(key, errors)
        for key in ("receiptNotProcessed", "receiptNotFound",
                    "itemNotOnReceipt", "splitNotFound"):
            self.assertIn(key, errors)

    def test_receipt_deletion_no_longer_promises_deletion_of_a_photo(self):
        desc = catalog("groups")["detail"]["deleteReceiptDescription"]
        self.assertNotIn("фотограф", desc)
        self.assertIn("Позиции чека", desc)

    def test_owner_export_does_not_export_old_photo_file_metadata(self):
        code = source("src/app/api/admin/export/route.ts")
        match = re.search(
            r"tx\.receipt\.findMany\(\{\s*select:\s*\{(?P<select>.*?)\}\s*,?\s*\}\)",
            code, re.S
        )
        self.assertIsNotNone(match)
        select = match.group("select")
        for key in ("imagePath", "originalName", "mimeType", "fileSize"):
            self.assertNotIn(key, select)
        for key in ("id", "status", "extractedData", "groupId", "savedById",
                    "createdAt", "updatedAt"):
            self.assertIn(key + ": true", select)
        for security in ("consumeOwnerPasskeyActionProof", "requireOwner",
                         "ownerSessionFingerprint", "recordOwnerSecurityEvent"):
            self.assertIn(security, code)
        self.assertIn("tx.receiptItem.findMany()", code)
        self.assertIn("Cache-Control': 'no-store, private'", code)

    def test_owner_user_export_excludes_obsolete_currency_preference(self):
        code = source("src/app/api/admin/export/route.ts")
        match = re.search(
            r"tx\.user\.findMany\(\{\s*select:\s*\{(?P<select>.*?)\}\s*,?\s*\}\)",
            code, re.S,
        )
        self.assertIsNotNone(match)
        selection = match.group("select")
        self.assertNotIn("defaultCurrency", selection)
        for field in ("id", "email", "suspendedAt", "createdAt", "updatedAt"):
            self.assertIn(field + ": true", selection)
        self.assertIn("consumeOwnerPasskeyActionProof", code)
        self.assertIn("await requireOwner(tx, session.user.id)", code)

    def test_schema_cleanup_intentionally_stays_in_94(self):
        schema = source("prisma/schema.prisma")
        self.assertIn("imagePath", schema)
        self.assertIn("originalName", schema)
        self.assertTrue((ROOT / "src/server/lib/receipt-cleanup.ts").exists())


if __name__ == "__main__":
    unittest.main()
