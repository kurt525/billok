#!/usr/bin/env python3
"""TASK-BILLOK-009: lifecycle and fail-closed orphan cleanup, no real deletion."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("billok_qa_resources", ROOT / "ops/ci-runner/billok-qa-resources.py")
qa = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = qa
SPEC.loader.exec_module(qa)
IDENT = qa.Identity("12345", "2", "a" * 32)
CONTAINER_ID = "c" * 64
OLD = "2020-01-01T00:00:00Z"


class FakeDocker:
    def __init__(self):
        self.container = None
        self.volume = None
        self.extra_attachment = False
        self.calls = []
        self.failure = None

    def make_volume(self, ident=IDENT):
        self.volume = {"Name": ident.volume, "Driver": "local", "Scope": "local",
                       "Options": None, "Labels": ident.labels, "CreatedAt": OLD}

    def make_container(self, ident=IDENT):
        self.container = {
            "Name": "/" + ident.container, "Id": CONTAINER_ID, "Created": OLD,
            "Config": {"Image": qa.IMAGE, "Labels": ident.labels,
                       "Env": ["POSTGRES_USER=billokqa", "POSTGRES_DB=billokqa",
                               "POSTGRES_PASSWORD=billokqa_local_only"]},
            "HostConfig": {"NetworkMode": "bridge", "Privileged": False,
                           "PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": ""}]}},
            "NetworkSettings": {"Networks": {"bridge": {}}},
            "Mounts": [{"Type": "volume", "Name": ident.volume, "Destination": qa.DATA, "RW": True}],
            "State": {"Status": "running", "Running": True, "Paused": False, "Restarting": False},
        }

    def inspect(self, kind, name):
        return self.volume if kind == "volume" else self.container

    def listed(self, kind):
        if kind == "volume":
            return {IDENT.volume} if self.volume else set()
        return {IDENT.container} if self.container else set()

    def attached(self, name):
        return ({CONTAINER_ID} if self.container else set()) | ({"other"} if self.extra_attachment else set())

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if self.failure == args[:2]:
            raise qa.Refused("injected Docker failure")
        if args[:2] == ("volume", "create"):
            self.make_volume()
        elif args[0] == "run":
            self.make_container()
        elif args[0] == "port":
            return "127.0.0.1:32123"
        elif args[0] == "rm":
            self.container = None
        elif args[:2] == ("volume", "rm"):
            self.volume = None
        else:
            raise AssertionError(args)
        return ""

    def mutating(self):
        return [c for c in self.calls if c[0] in ("rm", "run") or c[:2] in
                (("volume", "create"), ("volume", "rm"))]


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDocker()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for key in ("docker", "inspect", "listed", "attached"):
            self.stack.enter_context(patch.object(qa, key, getattr(self.fake, key)))
        self.stack.enter_context(patch.object(qa, "idle", return_value=True))
        self.stack.enter_context(patch.object(qa, "no_clients", return_value=True))
        self.stack.enter_context(patch("sys.stdout", new=io.StringIO()))

    def pair(self):
        self.fake.make_volume()
        self.fake.make_container()

    def test_start_then_cleanup_removes_named_volume_and_is_idempotent(self):
        records = []
        qa.start(IDENT, records.append)
        self.assertEqual(records[0], {"BILLOK_QA_RESOURCE_OWNER": IDENT.owner})
        self.assertEqual(records[1]["BILLOK_QA_DB_CONTAINER"], IDENT.container)
        self.assertIn("127.0.0.1:32123", records[1]["DATABASE_URL"])
        self.assertIn("type=volume,source=" + IDENT.volume + ",target=" + qa.DATA, self.fake.calls[1])
        self.assertEqual(qa.cleanup(IDENT), (2, 2))
        self.assertIn(("rm", "-f", "-v", CONTAINER_ID), self.fake.calls)
        self.assertIn(("volume", "rm", IDENT.volume), self.fake.calls)
        self.assertEqual(qa.cleanup(IDENT), (0, 0))

    def test_start_collision_never_records_or_mutates(self):
        self.fake.make_volume()
        records = []
        with self.assertRaises(qa.Refused):
            qa.start(IDENT, records.append)
        self.assertEqual(records, [])
        self.assertEqual(self.fake.calls, [])

    def test_volume_creation_error_does_not_authorize_foreign_cleanup(self):
        self.fake.failure = ("volume", "create")
        records = []
        with self.assertRaises(qa.Refused):
            qa.start(IDENT, records.append)
        self.assertEqual(records[0]["BILLOK_QA_RESOURCE_OWNER"], IDENT.owner)
        self.assertEqual(qa.cleanup(IDENT), (0, 0))

    def test_failed_container_creation_preserves_invocation_identity(self):
        self.fake.failure = ("run", "-d")
        records = []
        with self.assertRaises(qa.Refused):
            qa.start(IDENT, records.append)
        self.assertEqual(records, [{"BILLOK_QA_RESOURCE_OWNER": IDENT.owner}])
        self.assertIsNotNone(self.fake.volume)
        self.assertEqual(qa.cleanup(IDENT), (1, 1))

    def test_failed_or_cancelled_container_start_cleans_partial_volume(self):
        self.fake.make_volume()
        self.assertEqual(qa.cleanup(IDENT), (1, 1))
        self.assertEqual(self.fake.calls, [("volume", "rm", IDENT.volume)])

    def test_failed_test_uses_same_cleanup(self):
        self.pair()
        self.assertEqual(qa.cleanup(IDENT), (2, 2))

    def test_foreign_nonce_or_missing_label_rejected_without_deletion(self):
        for kind in ("volume", "container"):
            self.pair()
            info = self.fake.volume["Labels"] if kind == "volume" else self.fake.container["Config"]["Labels"]
            info.pop("ru.billok.component")
            with self.assertRaises(qa.Refused):
                qa.cleanup(IDENT)
            self.assertEqual(self.fake.calls, [])
        self.fake.make_volume(qa.Identity(IDENT.run, IDENT.attempt, "b" * 32))
        self.fake.container = None
        with self.assertRaises(qa.Refused):
            qa.cleanup(IDENT)
        self.assertEqual(self.fake.calls, [])

    def test_wrong_image_network_database_and_mount_refused(self):
        for field in ("image", "network", "database", "mount"):
            self.pair()
            c = self.fake.container
            if field == "image":
                c["Config"]["Image"] = "postgres:18"
            elif field == "network":
                c["NetworkSettings"]["Networks"]["other"] = {}
            elif field == "database":
                c["Config"]["Env"] = ["POSTGRES_DB=production"]
            else:
                c["Mounts"].append({"Type": "bind"})
            with self.assertRaises(qa.Refused):
                qa.cleanup(IDENT)
            self.assertEqual(self.fake.calls, [])

    def test_shared_volume_refuses_any_deletion(self):
        self.pair()
        self.fake.extra_attachment = True
        with self.assertRaises(qa.Refused):
            qa.cleanup(IDENT)
        self.assertEqual(self.fake.calls, [])
        self.fake.container = None
        with self.assertRaises(qa.Refused):
            qa.cleanup(IDENT)
        self.assertEqual(self.fake.calls, [])

    def test_failed_docker_removal_visible_and_volume_preserved(self):
        self.pair()
        self.fake.failure = ("rm", "-f")
        with self.assertRaises(qa.Refused):
            qa.cleanup(IDENT)
        self.assertIsNotNone(self.fake.volume)
        self.assertNotIn(("volume", "rm", IDENT.volume), self.fake.calls)
        self.fake.container = None
        self.fake.failure = ("volume", "rm")
        with self.assertRaises(qa.Refused):
            qa.cleanup(IDENT)

    def test_orphan_dry_run_does_not_delete(self):
        self.pair()
        self.assertEqual(qa.cleanup(IDENT, orphan=True, dry=True), (2, 0))
        self.assertEqual(self.fake.calls, [])

    def test_orphan_fresh_or_worker_or_client_is_protected(self):
        self.pair()
        self.fake.volume["CreatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        with self.assertRaises(qa.Refused):
            qa.cleanup(IDENT, orphan=True)
        self.pair()
        with patch.object(qa, "idle", return_value=False):
            with self.assertRaises(qa.Refused):
                qa.cleanup(IDENT, orphan=True)
        with patch.object(qa, "no_clients", return_value=False):
            with self.assertRaises(qa.Refused):
                qa.cleanup(IDENT, orphan=True)
        self.assertEqual(self.fake.calls, [])

    def test_orphan_scan_needs_verified_completed_run(self):
        self.pair()
        with patch.object(qa.os, "geteuid", return_value=0), patch.object(qa, "completed", return_value=False):
            self.assertEqual(qa.orphans(False), 0)
            self.assertEqual(self.fake.calls, [])
        with patch.object(qa.os, "geteuid", return_value=0), patch.object(qa, "completed", return_value=True):
            self.assertEqual(qa.orphans(True), 0)
            self.assertEqual(self.fake.calls, [])
            self.assertEqual(qa.orphans(False), 0)
            self.assertIsNone(self.fake.volume)

    def test_worker_starts_between_initial_check_and_deletion(self):
        self.pair()
        with patch.object(qa, "idle", side_effect=[True, False]):
            with self.assertRaises(qa.Refused):
                qa.cleanup(IDENT, orphan=True)
        self.assertEqual(self.fake.calls, [])


class RunProofTests(unittest.TestCase):
    def run_info(self, attempt=2, **changes):
        return dict({"id": 12345, "run_attempt": attempt, "workflow_id": qa.WORKFLOW_ID,
                     "path": qa.WORKFLOW_PATH, "repository": {"full_name": qa.REPO},
                     "head_repository": {"full_name": qa.REPO}, "event": "push",
                     "status": "completed", "conclusion": "cancelled"}, **changes)

    def test_exact_completed_or_previous_attempt(self):
        with patch.object(qa, "get_run", return_value=self.run_info()):
            self.assertTrue(qa.completed(IDENT))
        with patch.object(qa, "get_run", side_effect=[self.run_info(3), self.run_info()]) as get:
            self.assertTrue(qa.completed(IDENT))
            self.assertEqual(get.call_args.args, ("12345/attempts/2",))

    def test_unavailable_pending_wrong_repo_wrong_workflow_refused(self):
        for changes in ({"status": "in_progress"}, {"conclusion": None}, {"workflow_id": 1},
                        {"repository": {"full_name": "other/repo"}}, {"event": "pull_request"},
                        {"run_attempt": 1}, {"id": 99}):
            with patch.object(qa, "get_run", return_value=self.run_info(**changes)):
                self.assertFalse(qa.completed(IDENT))
        with patch.object(qa, "get_run", side_effect=OSError):
            self.assertFalse(qa.completed(IDENT))

    def test_invalid_identity_is_rejected(self):
        for run, attempt, nonce in (("x", "1", IDENT.owner), ("1", "0", IDENT.owner),
                                    ("1", "1", "bad"), ("1\n", "1", IDENT.owner)):
            with self.assertRaises(qa.Refused):
                qa.Identity(run, attempt, nonce)

    def test_postgres_connection_check_is_fail_closed(self):
        info = {"Id": CONTAINER_ID, "State": {"Status": "running", "Running": True}}
        with patch.object(qa, "docker", return_value="1"):
            self.assertFalse(qa.no_clients(info))
        with patch.object(qa, "docker", return_value="0"):
            self.assertTrue(qa.no_clients(info))
        with patch.object(qa, "docker", side_effect=qa.Refused("unavailable")):
            with self.assertRaises(qa.Refused):
                qa.no_clients(info)
        info["State"]["Paused"] = True
        self.assertFalse(qa.no_clients(info))
        info["State"] = {"Status": "exited", "Running": False}
        self.assertTrue(qa.no_clients(info))

    def test_workflow_and_host_guard_keep_existing_controls(self):
        ci = (ROOT / ".github/workflows/billok-ci.yml").read_text()
        guard = (ROOT / "ops/ci-runner/ci-runner-cleanup").read_text()
        self.assertIn("billok-qa-resources.py start", ci)
        self.assertIn("billok-qa-resources.py cleanup", ci)
        self.assertIn("name: Clean up identified mobile QA database and volume\n        if: always()", ci)
        self.assertIn("if: always()", ci)
        self.assertIn("python3 scripts/test_billok_qa_resources.py", ci)
        self.assertIn("flock -n 9", guard)
        self.assertIn("qa_only=1", guard)
        self.assertIn("qa_args+=(--dry-run)", guard)
        self.assertIn("RESULT=QA_CHECK_INCOMPLETE", guard)


if __name__ == "__main__":
    unittest.main()
