#!/usr/bin/env python3
"""Issue #1 8.11: production keys stay out of image, Docker inspect and logs.

Behavioral tests only mock stat UID (CI is unprivileged); permission modes
and the real secret validation logic remain active.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LOADER = ROOT / "docker/load-secrets.sh"
ENTRYPOINT = ROOT / "docker/entrypoint.sh"
SENSITIVE = {
    "DB_PASSWORD", "AUTH_SECRET", "NEXTAUTH_SECRET", "DATABASE_URL",
    "EMAIL_SERVER_PASSWORD", "WEB_PUSH_VAPID_PRIVATE_KEY",
}
DUMMY = {
    "postgres/prod.password": "a" * 64,
    "auth-secret": "b" * 64,
    "nextauth-secret": "c" * 64,
    "reg-ru-smtp-password": "qa-only-not-production",
}


def run_fixture(changes=None, missing=None, extra_env=None, link=None, insecure=None):
    with tempfile.TemporaryDirectory(prefix="billok-811-qa-") as tmp:
        root = Path(tmp)
        folder = root / "secret-files"
        folder.mkdir(mode=0o700)
        (folder / "postgres").mkdir(mode=0o700)
        for name, default in DUMMY.items():
            if name != missing:
                f = folder / name
                f.write_text((changes or {}).get(name, default) + "\n")
                f.chmod(0o644 if name == insecure else 0o600)
        if link:
            (folder / link).unlink()
            (folder / link).symlink_to(folder / "postgres/prod.password")
        bindir = root / "bin"
        bindir.mkdir()
        fake_stat = bindir / "stat"
        fake_stat.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = -c ] && [ \"$2\" = %u ]; then echo 0; exit 0; fi\n"
            "exec /usr/bin/stat \"$@\"\n"
        )
        fake_stat.chmod(0o700)
        staged = root / "load-secrets.sh"
        staged.write_text(
            LOADER.read_text(encoding="utf-8").replace("/run/billok-secrets", str(folder))
        )
        staged.chmod(0o600)
        env = {"PATH": str(bindir) + ":" + os.environ["PATH"], "BILLOK_DB_PHASE":"prod"}
        env.update(extra_env or {})
        result = subprocess.run(
            ["/bin/sh", "-c", '. "$1"; echo BILLOK_RUNTIME_SECRETS=VALID',
             "test", str(staged)],
            cwd=root, env=env, text=True, capture_output=True, timeout=8,
        )
        for secret in DUMMY.values():
            assert secret not in result.stdout and secret not in result.stderr
        return result


class ProductionSecretsTests(unittest.TestCase):
    def test_compose_has_readonly_file_mount_without_secret_env(self):
        output = subprocess.run(
            ["docker", "compose", "-f", str(ROOT / "docker/docker-compose.yml"),
             "config", "--format", "json"],
            capture_output=True, text=True, check=True, timeout=15,
        ).stdout
        app = json.loads(output)["services"]["billok"]
        self.assertTrue(SENSITIVE.isdisjoint(app.get("environment", {})))
        mounts = [m for m in app["volumes"] if m["target"] == "/run/billok-secrets"]
        self.assertEqual(len(mounts), 1)
        self.assertEqual(mounts[0]["source"], "/etc/billok/secrets")
        self.assertEqual(mounts[0]["type"], "bind")
        self.assertTrue(mounts[0]["read_only"])
        self.assertFalse(mounts[0]["bind"]["create_host_path"])
        self.assertEqual(app["ports"][0]["host_ip"], "127.0.0.1")

    def test_no_auth_secrets_in_dockerfile_or_image_context(self):
        dockerfile = (ROOT / "docker/Dockerfile").read_text()
        ignore = (ROOT / ".dockerignore").read_text()
        self.assertIn("COPY docker/load-secrets.sh /app/load-secrets.sh", dockerfile)
        for text in ("ARG AUTH_SECRET", "ARG DB_PASSWORD", "ENV AUTH_SECRET="):
            self.assertNotIn(text, dockerfile)
        for pattern in (
            ".env*", "**/.env*", ".npmrc", "**/.npmrc", "**/*.pem",
            "**/*.key", "**/*.p12", "**/secrets/",
        ):
            self.assertIn(pattern, ignore)

    def test_secret_files_choose_external_postgres(self):
        entry=ENTRYPOINT.read_text()
        loader=LOADER.read_text()
        self.assertLess(entry.index(". /app/load-secrets.sh"),entry.index("export DATABASE_URL="))
        self.assertIn("billok_pg_$BILLOK_DB_PHASE:5432",entry)
        self.assertNotIn("initdb",entry)
        self.assertNotIn("pg_ctl",entry)
        self.assertNotIn("prisma db push",entry)
        self.assertIn('read_billok_secret "postgres/$BILLOK_DB_PHASE.password"',loader)
        self.assertNotIn('echo "$DATABASE_URL"',entry)
    def test_shell_scripts_parse_correctly(self):
        for name in ("docker/load-secrets.sh", "docker/entrypoint.sh"):
            subprocess.run(["sh", "-n", str(ROOT / name)], check=True, timeout=5)

    def test_valid_mocked_root_secret_files_work(self):
        out = run_fixture()
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("BILLOK_RUNTIME_SECRETS=VALID", out.stdout)

    def test_missing_weak_insecure_and_symlink_files_are_rejected(self):
        for name in DUMMY:
            with self.subTest(missing=name):
                self.assertNotEqual(run_fixture(missing=name).returncode, 0)
        for changed in (
            {"auth-secret": "short"},
            {"postgres/prod.password": "x" * 64},
            {"nextauth-secret": ""},
            {"reg-ru-smtp-password": "row1\nrow2"},
        ):
            with self.subTest(changed=changed):
                self.assertNotEqual(run_fixture(changes=changed).returncode, 0)
        self.assertNotEqual(run_fixture(link="auth-secret").returncode, 0)
        self.assertNotEqual(run_fixture(insecure="auth-secret").returncode, 0)
        self.assertNotEqual(run_fixture(extra_env={"BILLOK_DB_PHASE":"wrong"}).returncode, 0)

    def test_preexisting_environment_secrets_are_rejected(self):
        for name in SENSITIVE:
            with self.subTest(variable=name):
                self.assertNotEqual(run_fixture(extra_env={name:"override"}).returncode, 0)

    def test_optional_push_secret_also_uses_secured_file(self):
        s = LOADER.read_text()
        self.assertIn("read_billok_secret vapid-private-key", s)
        self.assertIn("export WEB_PUSH_VAPID_PRIVATE_KEY", s)


if __name__ == "__main__":
    unittest.main()
