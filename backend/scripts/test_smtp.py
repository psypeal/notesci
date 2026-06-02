"""One-shot SMTP smoke test.

Sends a single plain + HTML email to admin@notesci.com using the
``SmtpEmailSender`` configured from the live ``.env``. Prints the
config it resolved (with the password redacted) and any error from
the SMTP handshake / auth / send.

Run from ``backend/``:

    .venv/bin/python scripts/test_smtp.py
"""
from __future__ import annotations

import asyncio
import sys
import traceback
from datetime import datetime, timezone

from notesci.config import settings
from notesci.email_sender import Email, build_sender


def _redact(s: str | None) -> str:
    if not s:
        return "<unset>"
    if len(s) <= 4:
        return "***"
    return s[:2] + "*" * (len(s) - 4) + s[-2:]


async def main() -> int:
    print("[smtp-test] resolved settings:")
    print(f"  backend  : {settings.notesci_email_backend}")
    print(f"  host     : {settings.notesci_smtp_host}")
    print(f"  port     : {settings.notesci_smtp_port}")
    print(f"  user     : {settings.notesci_smtp_user}")
    print(f"  password : {_redact(settings.notesci_smtp_password)}")
    print(f"  starttls : {settings.notesci_smtp_starttls}")
    print(f"  from     : {settings.notesci_email_from_invite}")

    if settings.notesci_email_backend != "smtp":
        print("[smtp-test] backend is not 'smtp' — bailing.", file=sys.stderr)
        return 2

    sender = build_sender()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    email = Email(
        to="admin@notesci.com",
        subject=f"notesci SMTP smoke test · {stamp}",
        text=(
            "This is the notesci SMTP smoke test.\n\n"
            f"Sent: {stamp}\n"
            f"From: {settings.notesci_email_from_invite}\n"
            f"SMTP: {settings.notesci_smtp_host}:{settings.notesci_smtp_port} "
            f"(starttls={settings.notesci_smtp_starttls})\n\n"
            "If you can read this in admin@notesci.com, the Titan SMTP "
            "wiring is good and the no-reply mailbox is delivering.\n"
        ),
        html=(
            "<p><b>notesci SMTP smoke test</b></p>"
            f"<p>Sent: {stamp}<br>"
            f"From: {settings.notesci_email_from_invite}<br>"
            f"SMTP: {settings.notesci_smtp_host}:{settings.notesci_smtp_port} "
            f"(starttls={settings.notesci_smtp_starttls})</p>"
            "<p>If you can read this in admin@notesci.com, the Titan SMTP "
            "wiring is good and the no-reply mailbox is delivering.</p>"
        ),
        from_address=settings.notesci_email_from_invite,
    )

    try:
        await sender.send(email)
    except Exception as exc:
        print("[smtp-test] send failed:", file=sys.stderr)
        traceback.print_exc()
        # Recognise the two common Titan failure modes so the operator
        # gets actionable next steps instead of a raw stack trace.
        msg = str(exc).lower()
        if "auth not allowed for mailbox" in msg or "authenticationfailed" in msg:
            print(
                "\n[smtp-test] Titan reports the mailbox is blocked from "
                "external app access.\n"
                "  • Sign into https://app.titan.email/ as "
                f"{settings.notesci_smtp_user}\n"
                "  • Settings → Mail / External Access\n"
                "  • Enable 'Allow IMAP / POP / SMTP access from other apps'\n"
                "  • Then re-run this script.",
                file=sys.stderr,
            )
        elif "535" in msg or "authentication failed" in msg:
            print(
                "\n[smtp-test] Titan rejected the credentials. Either:\n"
                "  • the password in .env is wrong, or\n"
                "  • the mailbox needs first-login via webmail to activate.\n"
                "  Sign into https://app.titan.email/ to verify the password "
                "and activate, then re-run.",
                file=sys.stderr,
            )
        return 1

    print(f"[smtp-test] ok — delivered to {email.to}")
    print("[smtp-test] check the inbox (and the spam folder) for the test message.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
