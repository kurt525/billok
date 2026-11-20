#!/usr/bin/env python3
"""Issue #1, 7.3: one-off authenticated REG.RU mail-delivery acceptance probe.

Never sends during CI, never logs a password, never accesses any recipient mailbox.
Delivery and spam placement must be verified at the external recipient.
"""
from __future__ import annotations

import argparse
from email.message import EmailMessage
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import sys
from uuid import uuid4

HOST = "mail.hosting.reg.ru"
SENDER = "noreply@billok.ru"
TOKEN_HEADER = "X-BillOK-Delivery-Check"


class ProbeError(Exception):
    pass


def safe_recipient(email: str) -> bool:
    if not 3 <= len(email) <= 254 or email != email.strip():
        return False
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", email, flags=re.ASCII):
        return False
    local, host = email.rsplit("@", 1)
    if local.startswith(".") or local.endswith(".") or ".." in local:
        return False
    labels = host.lower().split(".")
    if len(labels) < 2 or labels[-1] not in ("ru", "su"):
        return False
    return all(0 < len(p) <= 63 and
               re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", p, flags=re.ASCII)
               for p in labels)


def password_from_protected_file() -> str:
    filename = os.environ.get("BILLOK_MAIL_PASSWORD_FILE", "")
    if not filename or not Path(filename).is_absolute():
        raise ProbeError("SECRET_FILE_NOT_CONFIGURED")
    path = Path(filename)
    repository = Path(__file__).resolve().parent.parent
    if repository == path.resolve() or repository in path.resolve().parents:
        raise ProbeError("SECRET_MUST_LIVE_OUTSIDE_GIT_REPOSITORY")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ProbeError("SECRET_FILE_MUST_BE_REGULAR_AND_PRIVATE_0600")
    if info.st_uid not in (os.geteuid(), 0):
        raise ProbeError("SECRET_FILE_OWNER_MISMATCH")
    password = path.read_text(encoding="utf-8").rstrip("\r\n")
    if not password or len(password) > 1024:
        raise ProbeError("SECRET_FILE_EMPTY_OR_INVALID")
    return password


def tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def build_message(to: str, marker: str) -> EmailMessage:
    message = EmailMessage()
    message["From"] = f"BillOK <{SENDER}>"
    message["To"] = to
    message["Subject"] = "BillOK — проверка доставки электронной почты"
    message[TOKEN_HEADER] = marker
    message["Message-ID"] = f"<billok-delivery-{marker}@billok.ru>"
    message.set_content(
        "Контрольная проверка отправки писем BillOK через REG.RU.\n"
        "Это не письмо входа, подтверждения адреса или восстановления доступа.\n"
        "Никаких действий выполнять не требуется.\n",
        charset="utf-8",
    )
    message.add_alternative(
        "<div lang=\"ru\"><p>Контрольная проверка отправки писем BillOK через REG.RU.</p>"
        "<p>Это не ссылка для входа или восстановления. Никаких действий не требуется.</p></div>",
        subtype="html",
    )
    return message


def send_via_smtp(message: EmailMessage, password: str, context: ssl.SSLContext) -> None:
    # Never print exceptions: some providers include addresses or diagnostics.
    with smtplib.SMTP_SSL(HOST, 465, timeout=15, context=context) as smtp:
        smtp.login(SENDER, password)
        refused = smtp.send_message(
            message,
            from_addr=SENDER,
            to_addrs=[str(message["To"])],
        )
        if refused:
            raise ProbeError("SMTP_RECIPIENT_REFUSED")


def main() -> int:
    parser = argparse.ArgumentParser(description="Одноразовая проверка доставки почты BillOK через REG.RU")
    parser.add_argument("--send", action="store_true", help="Явно разрешить отправку одного контрольного письма")
    parser.add_argument("--to", help="Тестовый адрес в домене .ru или .su")
    args = parser.parse_args()

    if not args.send or os.environ.get("BILLOK_REAL_SMTP_TEST") != "1":
        raise ProbeError("REAL_DELIVERY_REQUIRES_SEND_FLAG_AND_OPT_IN")
    if not args.to or not safe_recipient(args.to):
        raise ProbeError("TEST_RECIPIENT_MUST_HAVE_RU_OR_SU_DOMAIN")
    # The noreply account is sender-only: no self-delivery acceptance shortcut.
    if args.to.lower() == SENDER:
        raise ProbeError("RECIPIENT_MUST_NOT_BE_NOREPLY_SENDER")
    password = password_from_protected_file()
    marker = uuid4().hex
    context = tls_context()
    send_via_smtp(build_message(args.to, marker), password, context)
    print("SMTP_AUTH=PASS")
    print("SMTP_ACCEPTED=PASS")
    # This script can only confirm SMTP submission, never recipient delivery.
    print("EXTERNAL_INBOX_AND_SPAM=NOT_VERIFIED")
    print("EXTERNAL_SPF_DKIM_DMARC_HEADERS=NOT_VERIFIED")
    print("CHECK_RECIPIENT_MAILBOX_MANUALLY=REQUIRED")
    print("TEST_MESSAGE_ID=" + str(build_message(args.to, marker)["Message-ID"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProbeError, OSError, smtplib.SMTPException, ssl.SSLError) as exc:
        print("MAIL_DELIVERY_CHECK=FAILED")
        print("FAILURE_TYPE=" + (str(exc) if isinstance(exc, ProbeError) else type(exc).__name__))
        sys.exit(1)
