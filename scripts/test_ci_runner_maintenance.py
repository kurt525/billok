#!/usr/bin/env python3
"""Issue #1 8.8: protect shared ci-runner, disks, Node and other projects.

This test never runs a destructive cleanup. Real status runs without sudo.
"""

from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "ops/ci-runner/ci-runner-cleanup"
WEEKLY = ROOT / "ops/ci-runner/docker-ci-gc"
CI = ROOT / ".github/workflows/billok-ci.yml"


class SafeRunnerMaintenanceTests(unittest.TestCase):
    def test_bash_syntax_and_non_destructive_status(self):
        for path in (SCRIPT, WEEKLY):
            subprocess.run(["bash", "-n", str(path)], check=True)
        status = subprocess.run(
            ["bash", str(SCRIPT), "status"], text=True, capture_output=True,
            timeout=15, check=True,
        )
        self.assertIn("RESULT=HEALTHY", status.stdout)
        self.assertIn("disk=/srv/ci-storage", status.stdout)
        self.assertIn("node=v22.23.4", status.stdout)
        self.assertIn("runner=active", status.stdout)

    def test_both_filesystems_control_health_and_pressure(self):
        source = SCRIPT.read_text(encoding="utf-8")
        for snippet in (
            'CI_DISK=/srv/ci-storage',
            'mountpoint -q "$CI_DISK"',
            'mountpoint -q "$RUNNER_WORK"',
            'root_pct="$(disk_pct /)"',
            'ci_pct="$(disk_pct "$CI_DISK")"',
            'root_pct >= 90 || ci_pct >= 90',
            'root_pct >= 80 || ci_pct >= 80',
            'before_pct_root < 80 && before_pct_ci < 80',
            'after_pct_root >= 90 || after_pct_ci >= 90',
            'after_pct_root >= 85 || after_pct_ci >= 85',
        ):
            self.assertIn(snippet, source)

    def test_cleanup_protects_other_runners_and_docker_data(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('local d=/opt/actions-runner-billok/_diag f', source)
        self.assertNotIn('/opt/actions-runner*/_diag', source)
        self.assertNotIn('docker builder prune', source)
        self.assertNotIn('docker image prune', source)
        self.assertNotIn('docker container prune', source)
        self.assertNotIn('docker system prune', source)
        self.assertNotIn('docker volume prune', source)
        self.assertIn('label=billok.ci.ephemeral=true', source)
        self.assertIn('billok-ci-temp-[0-9]+-[0-9]+', source)
        self.assertIn('runner_busy', source)
        self.assertIn('flock -n 9', source)

    def test_cleanup_never_removes_pinned_node_or_protected_directories(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('v22.23.4', source)
        self.assertIn('NODE_BIN=/opt/actions-runner-billok/_work/_tool/node/22.23.4/x64/bin/node', source)
        self.assertIn('/tmp/billok-node*', source)
        self.assertIn('/tmp/billok-backup*', source)
        self.assertIn('/tmp/billok-deploy*', source)
        self.assertIn('/tmp/billok-production*', source)
        self.assertIn('! -L "$d"', source)
        self.assertIn('rm -rf --one-file-system -- "$d"', source)
        self.assertIn('mmin -1440', source)
        self.assertIn('SKIP mounted or nested-mounted scratch', source)

    def test_weekly_timer_uses_same_scoped_cleanup_not_global_prune(self):
        weekly = WEEKLY.read_text(encoding="utf-8")
        self.assertIn('exec /usr/local/sbin/ci-runner-cleanup daily', weekly)
        for line in weekly.splitlines():
            self.assertFalse(line.lstrip().startswith(("docker ", "/usr/bin/docker ")))

    def test_all_five_ci_jobs_check_runner_disk_health(self):
        ci = CI.read_text(encoding="utf-8")
        self.assertEqual(ci.count('run: bash ops/ci-runner/ci-runner-cleanup status'), 5)
        self.assertIn('run: python3 scripts/test_ci_runner_maintenance.py', ci)
        self.assertEqual(ci.count('runs-on: [self-hosted, Linux, X64, billok]'), 5)


if __name__ == "__main__":
    unittest.main()
