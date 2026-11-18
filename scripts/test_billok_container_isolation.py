#!/usr/bin/env python3
"""Issue #1 8.9: source-level isolation, backup integrity and restore safety.

No real Docker container, disk or volume is modified by these regression tests.
Actual restore drills run separately with disposable labeled Docker volumes.
"""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/ops/billok-data-backup.py"
spec = importlib.util.spec_from_file_location("billok_data_backup", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def make_snapshot(root, malicious=False, symlink=False):
    snapshot = root / "billok-fixture"
    snapshot.mkdir(mode=0o700)
    (snapshot / "database.dump").write_bytes(b"nonempty-fixture-dump")
    with tarfile.open(snapshot / "uploads.tar.gz", "w:gz") as archive:
        folder = tarfile.TarInfo("uploads/receipts")
        folder.type = tarfile.DIRTYPE
        archive.addfile(folder)
        payload = b"billok-uploads-fixture"
        info = tarfile.TarInfo("uploads/receipts/test.txt")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
        if malicious or symlink:
            info = tarfile.TarInfo(
                "uploads/../../etc/passwd" if malicious else "uploads/receipts/evil-link"
            )
            info.type = tarfile.REGTYPE if malicious else tarfile.SYMTYPE
            info.linkname = "/etc/passwd" if symlink else ""
            archive.addfile(info)
    payload = {
        "format": "billok-8.9-v1",
        "created_utc": "2026-11-16T00:00:00+00:00",
        "source_volumes": {"postgres": "billok_pgdata", "uploads": "billok_uploads"},
        "sha256": {
            name: hashlib.sha256((snapshot / name).read_bytes()).hexdigest()
            for name in ("database.dump", "uploads.tar.gz")
        },
    }
    (snapshot / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
    return snapshot


class ContainerIsolationTests(unittest.TestCase):
    def test_compose_valid_and_named_separate_billok_volumes_only(self):
        command = ["docker", "compose", "-f", str(ROOT / "docker/docker-compose.yml"),
                   "config", "--format", "json"]
        cfg = json.loads(subprocess.run(command, text=True, capture_output=True,
                                        check=True, timeout=15).stdout)
        self.assertEqual(set(cfg["services"]), {"billok"})
        app = cfg["services"]["billok"]
        self.assertEqual(app["labels"]["ru.billok.project"], "billok")
        self.assertEqual(app["labels"]["ru.billok.component"], "application")
        self.assertEqual(set(cfg["volumes"]), {"pgdata", "uploads"})
        for key, name, kind in (
            ("pgdata", "billok_pgdata", "postgres"),
            ("uploads", "billok_uploads", "uploads"),
        ):
            volume = cfg["volumes"][key]
            self.assertEqual(volume["name"], name)
            self.assertEqual(volume["labels"]["ru.billok.project"], "billok")
            self.assertEqual(volume["labels"]["ru.billok.data"], kind)
        mounts = {m["target"]: m["source"] for m in app["volumes"]}
        self.assertEqual(mounts["/var/lib/postgresql/data"], "pgdata")
        self.assertEqual(mounts["/app/uploads"], "uploads")

    def test_resource_limits_logs_and_both_process_healthcheck(self):
        cfg = json.loads(subprocess.run(
            ["docker", "compose", "-f", str(ROOT / "docker/docker-compose.yml"),
             "config", "--format", "json"], text=True, capture_output=True,
            check=True, timeout=15).stdout)
        app = cfg["services"]["billok"]
        self.assertEqual(int(app["mem_limit"]), 2 * 1024 ** 3)
        self.assertEqual(app["pids_limit"], 256)
        self.assertEqual(str(app["cpus"]), "2")
        self.assertEqual(app["logging"]["driver"], "json-file")
        self.assertEqual(app["logging"]["options"], {"max-size": "10m", "max-file": "3"})
        health = app["healthcheck"]["test"]
        self.assertEqual(health[0], "CMD-SHELL")
        self.assertIn("pg_isready", health[1])
        self.assertIn("/api/health", health[1])

    def test_backup_verification_detects_corruption(self):
        with tempfile.TemporaryDirectory(prefix="billok-89-test-") as parent:
            snapshot = make_snapshot(Path(parent))
            with redirect_stdout(io.StringIO()):
                module.verify(snapshot)
            (snapshot / "database.dump").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
                module.verify(snapshot)

    def test_backup_rejects_traversal_and_symlinks(self):
        for params in ({"malicious": True}, {"symlink": True}):
            with self.subTest(params=params):
                with tempfile.TemporaryDirectory(prefix="billok-89-test-") as parent:
                    snapshot = make_snapshot(Path(parent), **params)
                    with self.assertRaisesRegex(ValueError, "Unsafe uploads"):
                        module.verify(snapshot)

    def test_snapshot_dir_rejects_unsafe_permissions(self):
        with tempfile.TemporaryDirectory(prefix="billok-89-perms-") as parent:
            path = Path(parent) / "snapshots"
            snapshot = module.snapshot_location(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o700)
            path.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "0700"):
                module.snapshot_location(path)

    def test_other_projects_cannot_be_backed_up(self):
        response = subprocess.CompletedProcess(
            ["docker", "inspect", "other-project"], 0,
            json.dumps([{
                "State": {"Running": True},
                "Config": {"Labels": {"ru.billok.project": "other-project"}},
                "Mounts": [{"Type": "volume", "Name": "other_pg", "Destination": module.PG_PATH}],
            }]),
            "",
        )
        with patch.object(module, "docker", return_value=response):
            with self.assertRaisesRegex(ValueError, "not a labeled BillOK"):
                module.inspect_container("other-project")

    def test_backup_never_restores_to_existing_data(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('docker("volume", "inspect", name, check=False', source)
        self.assertIn('raise ValueError("Refusing existing Docker volume:', source)
        self.assertIn('billok.ci.ephemeral=true', source)
        self.assertIn('"--network", "none"', source)
        self.assertNotIn("docker volume prune", source)
        self.assertNotIn("docker system prune", source)
        self.assertIn("container_started", source)
        self.assertIn("for volume in reversed(created_volumes)", source)


if __name__ == "__main__":
    unittest.main()
