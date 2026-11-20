#!/usr/bin/env python3
"""Issue #1 8.4: release/publish/switch stable only with separate owner consent.

These assertions test configuration without ever running any release job.
"""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / ".github" / "workflows"
RELEASES = {
    "auto-release.yml": ("BILLOK_RELEASE_APPROVED", "confirm_release", "РАЗРЕШАЮ РЕЛИЗ BILLOK"),
    "docker.yml": ("BILLOK_IMAGE_PUBLISH_APPROVED", "confirm_image", "РАЗРЕШАЮ DOCKER BILLOK"),
    "promote-stable.yml": ("BILLOK_STABLE_PROMOTION_APPROVED", "confirm_stable", "РАЗРЕШАЮ STABLE BILLOK"),
}


def read(name: str) -> str:
    return (WF / name).read_text(encoding="utf-8")


class ReleaseGateTests(unittest.TestCase):
    def test_no_automatic_release_or_image_publish_triggers(self):
        for name in RELEASES:
            code = read(name)
            trigger = code.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
            self.assertIn("  workflow_dispatch:\n", trigger, name)
            for forbidden in ("  push:", "  pull_request:", "  schedule:", "  workflow_run:", "  workflow_call:"):
                self.assertNotIn(forbidden, trigger, name)
        self.assertNotIn("docker push", read("billok-ci.yml"))
        self.assertNotIn("gh release create", read("billok-ci.yml"))

    def test_explicit_owner_permission_main_and_confirmation_all_required(self):
        for name, (variable, field, phrase) in RELEASES.items():
            code = read(name)
            self.assertIn("github.event_name == 'workflow_dispatch'", code, name)
            self.assertIn("github.ref == 'refs/heads/main'", code, name)
            self.assertIn("github.actor == github.repository_owner", code, name)
            self.assertIn("vars." + variable + " == 'true'", code, name)
            self.assertIn("inputs." + field + " == '" + phrase + "'", code, name)
            self.assertIn("      " + field + ":\n", code, name)
            self.assertIn("        required: true\n", code, name)

    def test_no_release_or_image_write_token_in_ci_jobs(self):
        ci = read("billok-ci.yml")
        self.assertIn("permissions:\n  contents: read", ci)
        self.assertNotIn("packages: write", ci)
        for name in RELEASES:
            code = read(name)
            self.assertIn("permissions:\n  contents: read", code, name)
        self.assertIn("    permissions:\n      contents: write", read("auto-release.yml"))
        self.assertIn("      packages: write", read("docker.yml"))
        self.assertNotIn("      contents: write", read("docker.yml"))
        self.assertIn("      packages: write", read("promote-stable.yml"))
        self.assertNotIn("      contents: write", read("promote-stable.yml"))

    def test_only_immutable_sha_docker_tag_is_published(self):
        code = read("docker.yml")
        self.assertIn("type=sha,prefix=", code)
        self.assertNotIn("type=raw,value=latest", code)
        self.assertNotIn("type=raw,value=stable", code)
        self.assertLess(code.index("- name: Smoke test the image"), code.index("- name: Push the tested image"))

    def test_stable_git_tag_is_never_moved_or_force_pushed(self):
        code = read("promote-stable.yml")
        self.assertNotIn("git tag -f", code)
        self.assertNotIn("git push -f", code)
        self.assertNotIn("- name: Move stable tag", code)
        self.assertIn('PROMOTE_REF:', code)
        self.assertIn('if [[ ! "$PROMOTE_REF" =~ ^[a-f0-9]{40}$ ]]', code)
        self.assertIn('git merge-base --is-ancestor "$PROMOTE_REF" origin/main', code)
        self.assertIn("persist-credentials: false", code)
        self.assertIn('imagetools create --tag', code)

    def test_dependabot_does_not_promise_upstream_autoreleases(self):
        code = (ROOT / ".github/dependabot.yml").read_text(encoding="utf-8")
        self.assertIn("manual-only", code)
        self.assertNotIn("runs on every push to main", code)


if __name__ == "__main__":
    unittest.main()
