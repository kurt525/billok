#!/usr/bin/env python3
"""Issue #1 8.3: CI token and secret exposure must stay read-only.

Publishing permissions and release triggers are reviewed separately in 8.4.
"""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
BILLOK_CI = (WORKFLOWS / "billok-ci.yml").read_text(encoding="utf-8")
JOB_IDS = (
    "code-quality",
    "unit-tests",
    "mobile-pwa-tests",
    "mobile-browser-smoke",
    "coverage-regression",
)


class BillokCiSecurityTests(unittest.TestCase):
    def test_five_ci_jobs_are_read_only_and_not_triggered_by_pull_requests(self):
        self.assertRegex(BILLOK_CI, r"(?m)^permissions:\n  contents: read$")
        self.assertNotRegex(BILLOK_CI, r"(?m)^  pull_request:")
        self.assertRegex(BILLOK_CI, r"(?m)^    branches: \[main, 'billok/\*\*'\]$")
        for job_id in JOB_IDS:
            self.assertRegex(
                BILLOK_CI,
                r"(?m)^  " + re.escape(job_id)
                + r":\n    permissions:\n      contents: read\n",
            )
        self.assertEqual(BILLOK_CI.count("    permissions:\n      contents: read\n"), 5)

    def test_checkout_does_not_persist_token_in_any_ci_job(self):
        # Never leave GITHUB_TOKEN in .git/config for npm, Vitest, build or
        # browser steps (including main baseline in coverage regression).
        self.assertEqual(BILLOK_CI.count("uses: actions/checkout@v4"), 5)
        self.assertEqual(BILLOK_CI.count("persist-credentials: false"), 5)
        self.assertIn("fetch-depth: 0", BILLOK_CI)
        for checkout in re.finditer(r"(?m)^        uses: actions/checkout@v4$", BILLOK_CI):
            following = BILLOK_CI[checkout.end():checkout.end() + 115]
            self.assertRegex(following, r"^\n        with:\n          persist-credentials: false\n")

    def test_ci_does_not_read_github_secrets_or_pass_a_token_to_untrusted_code(self):
        for workflow in ("billok-ci.yml", "audit.yml", "docker-fresh-install.yml"):
            content = (WORKFLOWS / workflow).read_text(encoding="utf-8")
            self.assertNotRegex(content, r"\$\{\{\s*secrets\.", workflow)
            self.assertNotRegex(content, r"\$\{\{\s*github\.token", workflow)
            self.assertNotRegex(content, r"(?m)^  pull_request:", workflow)
            self.assertNotRegex(content, r"(?m)^      (?:contents|packages|actions|id-token): write$", workflow)
            self.assertIn("persist-credentials: false", content, workflow)

    def test_ephemeral_qa_auth_secret_is_masked_and_not_exported_to_later_steps(self):
        self.assertIn('printf "::add-mask::%s\\n" "$AUTH_SECRET"', BILLOK_CI)
        self.assertNotIn('echo "AUTH_SECRET=$AUTH_SECRET" >> "$GITHUB_ENV"', BILLOK_CI)
        self.assertNotRegex(BILLOK_CI, r"\$\{\{\s*secrets\.")

    def test_manual_audit_and_docker_smoke_have_only_checkout_read_access(self):
        for name in ("audit.yml", "docker-fresh-install.yml"):
            content = (WORKFLOWS / name).read_text(encoding="utf-8")
            self.assertIn("permissions:\n      contents: read\n", content, name)
            self.assertIn("persist-credentials: false", content, name)
            self.assertNotRegex(content, r"(?m)^  (?:push|pull_request|schedule):")


if __name__ == "__main__":
    unittest.main()
