#!/usr/bin/env python3
"""Issue #1 8.10: safe Nginx/HTTPS release staging without deploying anything.

The tests never bind or publish a network port and do not request certificates.
"""
from pathlib import Path
import json
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent
NGINX = ROOT / "ops/billok/nginx"
COMPOSE = ROOT / "docker/docker-compose.yml"


class BillokHttpsProxyTests(unittest.TestCase):
    def test_upstream_docker_port_can_only_bind_ipv4_loopback(self):
        cfg = json.loads(subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE), "config", "--format", "json"],
            check=True, capture_output=True, text=True, timeout=15,
        ).stdout)
        app = cfg["services"]["sharetab"]
        ports = app.get("ports")
        self.assertEqual(len(ports), 1)
        self.assertEqual(ports[0]["host_ip"], "127.0.0.1")
        self.assertEqual(str(ports[0]["published"]), "3000")
        self.assertEqual(int(ports[0]["target"]), 3000)
        self.assertNotIn("network_mode", app)
        self.assertNotIn("privileged", app)

    def test_acme_stage_has_only_http_challenge_without_app_proxy(self):
        conf = (NGINX / "billok-acme.conf").read_text(encoding="utf-8")
        self.assertIn("listen 89.169.2.31:80;", conf)
        self.assertIn("server_name billok.ru;", conf)
        self.assertIn("location ^~ /.well-known/acme-challenge/", conf)
        self.assertIn("root /var/www/billok-acme;", conf)
        self.assertIn("try_files $uri =404;", conf)
        self.assertIn("return 404;", conf)
        for forbidden in ("proxy_pass", "ssl_certificate", "listen 89.169.2.31:443"):
            self.assertNotIn(forbidden, conf)

    def test_https_stage_has_own_domain_cert_and_modern_tls(self):
        conf = (NGINX / "billok-https.conf").read_text(encoding="utf-8")
        self.assertIn("listen 89.169.2.31:80;", conf)
        self.assertIn("listen 89.169.2.31:443 ssl;", conf)
        self.assertEqual(conf.count("server_name billok.ru;"), 2)
        self.assertIn("ssl_certificate /etc/letsencrypt/live/billok.ru/fullchain.pem;", conf)
        self.assertIn("ssl_certificate_key /etc/letsencrypt/live/billok.ru/privkey.pem;", conf)
        self.assertIn("ssl_protocols TLSv1.2 TLSv1.3;", conf)
        self.assertIn('Strict-Transport-Security "max-age=31536000"', conf)
        self.assertIn('add_header X-Content-Type-Options nosniff always;', conf)
        self.assertIn("return 308 https://billok.ru$request_uri;", conf)

    def test_proxy_is_loopback_only_and_untrusted_forwarded_headers_not_passed(self):
        conf = (NGINX / "billok-https.conf").read_text(encoding="utf-8")
        self.assertEqual(conf.count("proxy_pass http://127.0.0.1:3000;"), 1)
        self.assertNotIn("proxy_pass http://0.0.0.0", conf)
        self.assertNotIn("$proxy_add_x_forwarded_for", conf)
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", conf)
        self.assertIn("proxy_set_header Host billok.ru;", conf)
        self.assertIn("proxy_set_header X-Forwarded-Proto https;", conf)
        self.assertIn("proxy_set_header X-Forwarded-Host billok.ru;", conf)
        self.assertIn("proxy_set_header X-Forwarded-Port 443;", conf)
        self.assertIn("proxy_set_header Upgrade $http_upgrade;", conf)
        self.assertIn("proxy_set_header Connection $billok_connection_upgrade;", conf)
        self.assertIn("proxy_buffering off;", conf)
        self.assertIn("proxy_read_timeout 3600s;", conf)

    def test_https_does_not_accidentally_enable_before_certificate(self):
        guide = (ROOT / "ops/billok/HTTPS-PREDEPLOY.md").read_text(encoding="utf-8")
        self.assertIn("billok-acme.conf", guide)
        self.assertIn("billok-https.conf", guide)
        self.assertIn("certbot certonly", guide)
        self.assertIn("nginx -t", guide)
        self.assertIn("certbot renew --dry-run", guide)
        self.assertIn("BILLOK_INTERNAL_PORT", guide)
        self.assertIn("NEXTAUTH_URL=https://billok.ru", guide)
        self.assertIn("не опубликован", guide.lower())
        self.assertNotIn("sudo docker compose up -d", guide)
        self.assertIn("8.11", guide)

    def test_earlier_release_gates_not_bypassed(self):
        ci = (ROOT / ".github/workflows/billok-ci.yml").read_text(encoding="utf-8")
        self.assertIn("python3 scripts/test_billok_https_proxy.py", ci)
        self.assertNotIn("certbot certonly", ci)
        self.assertNotIn("systemctl reload nginx", ci)
        self.assertNotIn("docker compose up", ci)
        for name in ("auto-release.yml", "docker.yml", "promote-stable.yml"):
            release = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertIn("  workflow_dispatch:", release)
            trigger = release.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
            self.assertNotIn("  push:", trigger)


if __name__ == "__main__":
    unittest.main()
