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
        "source_volumes": {"postgres": "billok_pg_prod_data", "uploads": "billok_uploads"},
        "sha256": {
            name: hashlib.sha256((snapshot / name).read_bytes()).hexdigest()
            for name in ("database.dump", "uploads.tar.gz")
        },
    }
    (snapshot / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
    return snapshot


class ContainerIsolationTests(unittest.TestCase):
    def test_compose_connects_preexisting_prod_pg_and_no_new_pg_volume(self):
        c=json.loads(subprocess.run(["docker","compose","-f",str(ROOT/"docker/docker-compose.yml"),
             "config","--format","json"],capture_output=True,text=True,check=True,timeout=15).stdout)
        self.assertEqual(set(c["services"]), {"billok"})
        app=c["services"]["billok"]
        self.assertEqual(app["labels"]["ru.billok.project"], "billok")
        self.assertEqual(app["labels"]["ru.billok.component"], "application")
        self.assertEqual(app["environment"]["BILLOK_DB_PHASE"], "prod")
        self.assertEqual(set(c["volumes"]), {"uploads"})
        self.assertEqual(c["volumes"]["uploads"]["name"], "billok_uploads")
        self.assertEqual(c["volumes"]["uploads"]["labels"]["ru.billok.data"], "uploads")
        self.assertTrue(c["networks"]["billok_pg_prod_net"]["external"])
        self.assertEqual(c["networks"]["billok_pg_prod_net"]["name"], "billok_pg_prod_net")
        self.assertIn("billok_pg_prod_net",app["networks"])
        mounts={m["target"]:m["source"] for m in app["volumes"]}
        self.assertEqual(mounts["/app/uploads"], "uploads")
        self.assertNotIn("/var/lib/postgresql/data", mounts)
    def test_runtime_cannot_create_embedded_pg(self):
        df=(ROOT/"docker/Dockerfile").read_text()
        entry=(ROOT/"docker/entrypoint.sh").read_text()
        for token in ("postgresql16","PGDATA=","/var/lib/postgresql/data","/prisma-cli"):
            self.assertNotIn(token,df)
        for token in ("initdb","pg_ctl","CREATE DATABASE","prisma db push","psql "):
            self.assertNotIn(token,entry)
        self.assertIn("billok_pg_$BILLOK_DB_PHASE:5432",entry)
        self.assertIn("exec su-exec nextjs node server.js",entry)
        # Runtime never elevates permissions to work around private asset dirs.
        # Files served from /public must be traversable by uid=nextjs.
        self.assertIn("COPY --chown=nextjs:nodejs --from=builder /app/public ./public",df)
        self.assertNotIn("USER root",df)
    def test_resource_limits_logs_and_healthcheck(self):
        c=json.loads(subprocess.run(["docker","compose","-f",str(ROOT/"docker/docker-compose.yml"),
             "config","--format","json"],capture_output=True,text=True,check=True,timeout=15).stdout)
        app=c["services"]["billok"]
        self.assertEqual(int(app["mem_limit"]), 2*1024**3)
        self.assertEqual(app["pids_limit"],256)
        self.assertEqual(str(app["cpus"]),"2")
        self.assertEqual(app["logging"]["driver"],"json-file")
        self.assertEqual(app["logging"]["options"],{"max-size":"10m","max-file":"3"})
        h=app["healthcheck"]["test"]
        self.assertEqual(h[0],"CMD-SHELL")
        self.assertNotIn("pg_isready",h[1])
        self.assertIn("/api/health",h[1])

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
