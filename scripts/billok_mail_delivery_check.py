#!/usr/bin/env python3
"""Issue #1, 7.3: one-off authenticated REG.RU mail-delivery acceptance probe.

Never runs during CI, never logs a password, never modifies existing mail.
The optional IMAP check reads only headers of the test message.
"""
from __future__ import annotations

import argparse
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default
import imaplib
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import sys
import time
from uuid import uuid4

HOST = "mail.hosting.reg.ru"
SENDER = "noreply@billok.ru"
TOKEN_HEADER = "X-BillOK-Delivery-Check"
MAX_WAIT_SECONDS = 30


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


def _mailboxes(imap: imaplib.IMAP4_SSL) -> list[tuple[str, str]]:
    status, rows = imap.list()
    if status != "OK" or not rows:
        raise ProbeError("IMAP_LIST_FAILED")
    result = []
    for row in rows:
        if not row:
            continue
        # LIST names are IMAP modified UTF-7 (safe to pass back to SELECT).
        raw = row.decode("ascii", "replace")
        matched = re.search(r'^\(([^)]*)\)\s+(?:"[^"]*"|NIL)\s+(.+)$', raw)
        if not matched:
            continue
        attributes = matched.group(1).lower()
        folder = matched.group(2).strip().strip('"')
        lower = folder.lower()
        if lower == "inbox":
            result.append(("INBOX", folder))
        elif "\\junk" in attributes or re.search(r"(?:^|[/\\.])(?:spam|junk)$", lower):
            result.append(("SPAM", folder))
    return result


def _imap_marker_header(imap: imaplib.IMAP4_SSL, marker: str) -> bytes | None:
    status, rows = imap.search(None, "HEADER", TOKEN_HEADER, marker)
    if status != "OK" or not rows or not rows[0]:
        return None
    # Header-only retrieval; do not download/read users' private message bodies.
    message_id = rows[0].split()[-1]
    status, payload = imap.fetch(
        message_id, "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT MESSAGE-ID AUTHENTICATION-RESULTS)])"
    )
    if status != "OK" or not payload:
        raise ProbeError("IMAP_HEADER_FETCH_FAILED")
    for item in payload:
        if isinstance(item, tuple) and len(item) == 2 and isinstance(item[1], bytes):
            return item[1]
    return None


def check_own_mailbox(marker: str, password: str, context: ssl.SSLContext, timeout: int) -> str:
    deadline = time.monotonic() + timeout
    with imaplib.IMAP4_SSL(HOST, 993, ssl_context=context, timeout=15) as mailbox:
        mailbox.login(SENDER, password)
        folders = _mailboxes(mailbox)
        if not any(kind == "INBOX" for kind, _ in folders):
            raise ProbeError("IMAP_INBOX_NOT_FOUND")
        while True:
            for kind, folder in folders:
                status, _ = mailbox.select(folder, readonly=True)
                if status != "OK":
                    continue
                payload = _imap_marker_header(mailbox, marker)
                if payload is not None:
                    header = BytesParser(policy=default).parsebytes(payload, headersonly=True)
                    results = " ".join(str(v) for v in header.get_all("Authentication-Results", [])).lower()
                    auth = "PRESENT" if results else "NOT_PRESENT"
                    # Internal self-delivery can omit all Authentication-Results.
                    # Report observed receiver verdicts, never infer PASS from DNS.
                    print(f"IMAP_DELIVERY={kind}")
                    print(f"AUTHENTICATION_RESULTS={auth}")
                    for mechanism in ("spf", "dkim", "dmarc"):
                        matched = re.search(
                            rf"\b{mechanism}=(pass|fail|none|neutral|softfail|temperror|permerror)\b",
                            results,
                        )
                        print(f"AUTH_{mechanism.upper()}={matched.group(1).upper() if matched else 'NOT_PRESENT'}")
                    return kind
            if time.monotonic() >= deadline:
                break
            time.sleep(min(3, max(0, deadline - time.monotonic())))
        raise ProbeError("MAIL_NOT_FOUND_IN_INBOX_OR_SPAM")


def main() -> int:
    parser = argparse.ArgumentParser(description="Одноразовая проверка доставки почты BillOK через REG.RU")
    parser.add_argument("--send", action="store_true", help="Явно разрешить отправку одного контрольного письма")
    parser.add_argument("--to", help="Тестовый адрес в домене .ru или .su")
    parser.add_argument("--check-own-inbox", action="store_true", help="Проверить по IMAP ящик noreply@billok.ru")
    args = parser.parse_args()

    if not args.send or os.environ.get("BILLOK_REAL_SMTP_TEST") != "1":
        raise ProbeError("REAL_DELIVERY_REQUIRES_SEND_FLAG_AND_OPT_IN")
    if not args.to or not safe_recipient(args.to):
        raise ProbeError("TEST_RECIPIENT_MUST_HAVE_RU_OR_SU_DOMAIN")
    if args.check_own_inbox and args.to.lower() != SENDER:
        raise ProbeError("IMAP_CHECK_ONLY_FOR_OWN_MAILBOX")
    password = password_from_protected_file()
    marker = uuid4().hex
    context = tls_context()
    send_via_smtp(build_message(args.to, marker), password, context)
    print("SMTP_AUTH=PASS")
    print("SMTP_ACCEPTED=PASS")
    if args.check_own_inbox:
        check_own_mailbox(marker, password, context, MAX_WAIT_SECONDS)
    else:
        print("EXTERNAL_INBOX_AND_SPAM=NOT_VERIFIED")
        print("EXTERNAL_SPF_DKIM_DMARC_HEADERS=NOT_VERIFIED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProbeError, OSError, smtplib.SMTPException, imaplib.IMAP4.error, ssl.SSLError) as exc:
        print("MAIL_DELIVERY_CHECK=FAILED")
        print("FAILURE_TYPE=" + (str(exc) if isinstance(exc, ProbeError) else type(exc).__name__))
        sys.exit(1)
