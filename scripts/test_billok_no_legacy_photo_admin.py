#!/usr/bin/env python3
"""Issue #1 9.3 — no orphan image filesystem administration.

Keep necessary receipt *database* cleanup, its owner authorization, and
mobile 320-720px confirmation tests. Do not edit Prisma/SQL (Issue 9.4).
"""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


def read(path):
    return (ROOT / path).read_text(encoding="utf8")


class NoLegacyPhotoAdminTests(unittest.TestCase):
    def test_admin_api_has_no_filesystem_scanning_or_orphan_deletion(self):
        admin = read("src/server/trpc/routers/admin.ts")
        for legacy in (
            "cleanupOrphans: adminProcedure", "process.env.UPLOAD_DIR",
            "fs.existsSync", "fsp.readdir", "fsp.unlink", "fs/promises",
            "select: { imagePath: true }", "orphanPaths",
        ):
            self.assertNotIn(legacy, admin)
        self.assertIn("getStorageStats: adminProcedure.query", admin)
        self.assertIn("countUnusedReceipts(ctx.db)", admin)
        self.assertIn("cleanupUnusedReceipts: adminProcedure.mutation", admin)
        self.assertIn("deleteUnusedReceipts(ctx.db, 500)", admin)
        self.assertIn("requireOwner(ctx.db, ctx.user.id)", admin)

    def test_mobile_admin_keeps_db_receipts_and_single_confirmed_delete(self):
        admin = read("src/app/[locale]/(app)/admin/page.tsx")
        for legacy in (
            "cleanupOrphans", "orphanCount", "totalDiskUsageFormatted",
            "admin-storage-disk-usage", "FileWarning", "HardDrive",
        ):
            self.assertNotIn(legacy, admin)
        for kept in (
            "admin-storage-stats", "unused-receipts-card",
            "admin-storage-open-cleanup", "admin-storage-cleanup-dialog",
            "admin-storage-cleanup-cancel", "admin-storage-cleanup-confirm",
            "trpc.admin.cleanupUnusedReceipts.useMutation",
        ):
            self.assertIn(kept, admin)

    def test_orphaned_image_translations_are_not_active(self):
        admin = json.loads(read("messages/ru/admin.json"))
        storage = admin["storage"]
        for dead in (
            "diskUsage", "filesOnDisk", "orphanedFiles", "orphanDescription",
            "confirmOrphansTitle", "confirmOrphansDescription", "cleanedUp",
        ):
            self.assertNotIn(dead, storage)
        for kept in (
            "receipts", "inDatabase", "unusedReceipts",
            "confirmUnusedTitle", "confirmUnusedDescription", "unusedCleanedUp",
        ):
            self.assertIn(kept, storage)

    def test_six_width_chromium_checks_must_remain(self):
        e2e = read("e2e/billok-mobile-authenticated.spec.ts")
        self.assertIn("section === health ? 3 : 2", e2e)
        self.assertIn("toHaveCount(1)", e2e)
        self.assertIn("closing", e2e.lower())
        self.assertIn("admin.cleanupUnusedReceipts", e2e)
        self.assertNotIn("admin.cleanupOrphans", e2e)
        self.assertIn("[320, 360, 430, 480, 600, 720]", e2e)

    def test_93_no_filesystem_receipt_cleanup(self):
        cleanup = read("src/server/lib/receipt-cleanup.ts")
        admin = read("src/server/trpc/routers/admin.ts")
        group = read("src/server/lib/group-delete.ts")
        for src in (cleanup, admin, group):
            self.assertNotIn("removeReceiptFiles", src)
        for name in ("unlink(", "resolveUploadPath", "fileSize", "imagePath"):
            self.assertNotIn(name, cleanup)
        self.assertNotIn("unusedReceiptBytes", admin)
        self.assertFalse((ROOT / "src/server/lib/upload-dir.ts").exists())
        self.assertIn("deleteUnusedReceipts", cleanup)
        self.assertIn("deleteReceiptsNoSplitUses", group)

    def test_schema_and_db_cleanup_remain_in_issue_94(self):
        schema = read("prisma/schema.prisma")
        self.assertNotIn("imagePath", schema)
        self.assertNotIn("fileSize", schema)
        self.assertTrue((ROOT / "src/server/lib/receipt-cleanup.ts").exists())
        self.assertIn("deleteUnusedReceipts", read("src/server/lib/receipt-cleanup.ts"))


if __name__ == "__main__":
    unittest.main()
