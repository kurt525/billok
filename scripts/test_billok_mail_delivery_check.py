"""Unit tests for 7.3 REG.RU outgoing mail probe. Never contact real SMTP."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import ssl
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

MODULE = Path(__file__).with_name("billok_mail_delivery_check.py")
spec = importlib.util.spec_from_file_location("billok_mail_delivery_check", MODULE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class BillOKMailDeliveryProbeTests(unittest.TestCase):
    def test_rejects_unsafe_recipient_and_non_ru_su_domains(self):
        for name in ["a@mail.ru", "me@subdomain.billok.su", "UPPER@EXAMPLE.RU"]:
            self.assertTrue(probe.safe_recipient(name), name)
        for name in [
            "a@example.com", "a@example.рф", "a@mail.ru.evil.com", "a@mail-ru.com",
            "a@localhost", "a@mail.ru.", "a@@mail.ru", "a@mail.ru\nBcc: evil",
            " a@mail.ru", "a@-mail.ru", "a@mail..ru", "a@mail_rus.ru",
        ]:
            self.assertFalse(probe.safe_recipient(name), name)

    def test_requires_regular_owner_only_secret_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "smtp"
            path.write_text("dummy-only-test-password\n", encoding="utf-8")
            path.chmod(0o600)
            with patch.dict(os.environ, {"BILLOK_MAIL_PASSWORD_FILE": str(path)}):
                self.assertEqual(probe.password_from_protected_file(), "dummy-only-test-password")
                path.chmod(0o640)
                with self.assertRaises(probe.ProbeError):
                    probe.password_from_protected_file()
                path.chmod(0o600)
                symlink = Path(root) / "link"
                symlink.symlink_to(path)
                with patch.dict(os.environ, {"BILLOK_MAIL_PASSWORD_FILE": str(symlink)}):
                    with self.assertRaises(probe.ProbeError):
                        probe.password_from_protected_file()

    def test_requires_explicit_secret_location(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(probe.ProbeError, "SECRET_FILE_NOT_CONFIGURED"):
                probe.password_from_protected_file()

    def test_message_contains_no_passkey_or_login_tokens(self):
        marker = "a" * 32
        message = probe.build_message("person@mail.ru", marker)
        self.assertEqual(message["X-BillOK-Delivery-Check"], marker)
        self.assertEqual(message["From"].addresses[0].addr_spec, probe.SENDER)
        self.assertEqual(message["To"], "person@mail.ru")
        self.assertEqual(len(message.get_payload()), 2)
        body = message.as_string()
        self.assertIn("Content-Type: multipart/alternative", body)
        self.assertNotIn("recover-passkey", body)
        self.assertNotIn("verify-email", body)

    def test_tls_verification_is_required(self):
        ctx = probe.tls_context()
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertGreaterEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)

    def test_smtp_uses_exact_reg_ru_host_and_authenticated_sender(self):
        msg = probe.build_message("person@mail.ru", "a" * 32)
        smtp = MagicMock()
        smtp.__enter__.return_value = smtp
        smtp.send_message.return_value = {}
        with patch.object(probe.smtplib, "SMTP_SSL", return_value=smtp) as factory:
            probe.send_via_smtp(msg, "mock-secret", probe.tls_context())
            self.assertEqual(factory.call_args.args[:2], (probe.HOST, 465))
            smtp.login.assert_called_once_with(probe.SENDER, "mock-secret")
            self.assertEqual(smtp.send_message.call_args.kwargs["to_addrs"], ["person@mail.ru"])
            self.assertEqual(smtp.send_message.call_args.kwargs["from_addr"], probe.SENDER)
            smtp.send_message.return_value = {"person@mail.ru": (550, b"refused")}
            with self.assertRaisesRegex(probe.ProbeError, "SMTP_RECIPIENT_REFUSED"):
                probe.send_via_smtp(msg, "mock-secret", probe.tls_context())

    def test_never_sends_without_manual_opt_in_and_approved_recipient(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(sys, "argv", ["probe", "--send", "--to", "me@mail.ru"]):
                with patch.object(probe, "send_via_smtp") as send:
                    with self.assertRaisesRegex(probe.ProbeError, "OPT_IN"):
                        probe.main()
                    send.assert_not_called()
        with patch.dict(os.environ, {"BILLOK_REAL_SMTP_TEST": "1"}):
            with patch.object(sys, "argv", ["probe", "--send", "--to", "me@example.com"]):
                with patch.object(probe, "send_via_smtp") as send:
                    with self.assertRaisesRegex(probe.ProbeError, "RU_OR_SU"):
                        probe.main()
                    send.assert_not_called()

    def test_no_self_delivery_and_no_claim_of_inbox_verification(self):
        with patch.dict(os.environ, {"BILLOK_REAL_SMTP_TEST": "1"}), \
            patch.object(probe, "password_from_protected_file", return_value="dummy"), \
            patch.object(probe, "send_via_smtp") as send, \
            patch.object(sys, "argv", ["probe", "--send", "--to", probe.SENDER]):
            with self.assertRaisesRegex(probe.ProbeError, "RECIPIENT_MUST_NOT_BE_NOREPLY_SENDER"):
                probe.main()
            send.assert_not_called()

        with patch.dict(os.environ, {"BILLOK_REAL_SMTP_TEST": "1"}), \
            patch.object(probe, "password_from_protected_file", return_value="dummy"), \
            patch.object(probe, "send_via_smtp") as send, \
            patch.object(sys, "argv", ["probe", "--send", "--to", "tester@mail.ru"]):
            with contextlib.redirect_stdout(io.StringIO()) as log:
                self.assertEqual(probe.main(), 0)
            text = log.getvalue()
            self.assertIn("SMTP_ACCEPTED=PASS", text)
            self.assertIn("EXTERNAL_INBOX_AND_SPAM=NOT_VERIFIED", text)
            self.assertIn("CHECK_RECIPIENT_MAILBOX_MANUALLY=REQUIRED", text)
            self.assertIn("TEST_MESSAGE_ID=", text)
            send.assert_called_once()

    def test_imap_option_cannot_be_requested(self):
        with patch.dict(os.environ, {"BILLOK_REAL_SMTP_TEST": "1"}), \
            patch.object(probe, "send_via_smtp") as send, \
            patch.object(sys, "argv", [
                "probe", "--send", "--to", "tester@mail.ru", "--check-own-inbox"
            ]):
            with self.assertRaises(SystemExit) as error:
                probe.main()
            self.assertEqual(error.exception.code, 2)
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
