#!/usr/bin/env python3
"""Issue #1 8.2: routing regression; release gating belongs exclusively to 8.4."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"


class BillokWorkflowRoutingTests(unittest.TestCase):
    def test_no_duplicate_upstream_test_or_automatic_issue_assignment(self):
        self.assertFalse((WORKFLOWS / "test.yml").exists())
        self.assertFalse((WORKFLOWS / "auto-assign.yml").exists())

    def test_only_five_required_ci_jobs_on_trusted_self_hosted_runner(self):
        workflow = (WORKFLOWS / "billok-ci.yml").read_text(encoding="utf-8")
        self.assertIn("branches: [main, 'billok/**', 'task/billok-002-create-receipt']", workflow)
        self.assertNotIn("'task/**'", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertNotIn("ubuntu-latest", workflow)
        self.assertEqual(workflow.count("runs-on: [self-hosted, Linux, X64, billok]"), 5)
        for name in (
            "Code quality and types",
            "Unit tests (Vitest)",
            "Coverage regression (%)",
            "BillOK mobile PWA tests",
            "Mobile Chromium (320–720 px)",
        ):
            self.assertIn("name: " + name, workflow)
        self.assertIn("22.23.4", workflow)

    def test_audit_only_manual_and_with_required_node_version(self):
        workflow = (WORKFLOWS / "audit.yml").read_text(encoding="utf-8")
        self.assertIn("on:\n  workflow_dispatch:\n", workflow)
        for disallowed in ("schedule:", "pull_request:", "push:", "ubuntu-latest"):
            self.assertNotIn(disallowed, workflow)
        self.assertIn("runs-on: [self-hosted, Linux, X64, billok]", workflow)
        self.assertIn("22.23.4", workflow)
        self.assertIn("npm audit --audit-level=high --omit=dev", workflow)

    def test_docker_smoke_requires_manually_provisioned_isolated_runner(self):
        workflow = (WORKFLOWS / "docker-fresh-install.yml").read_text(encoding="utf-8")
        self.assertIn("on:\n  workflow_dispatch:\n", workflow)
        self.assertNotIn("ubuntu-latest", workflow)
        self.assertIn("runs-on: [self-hosted, Linux, X64, billok-docker-smoke]", workflow)
        self.assertIn("tags: billok:ci", workflow)
        self.assertIn("scripts/docker-smoke.sh --image billok:ci", workflow)


if __name__ == "__main__":
    unittest.main()
