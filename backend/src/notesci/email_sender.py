"""Email sending — pluggable backend + transactional templates.

HTML rendering uses inline CSS (email clients strip stylesheets), a
600px-wide centered container per the design handoff, brand-token
hex approximations of the oklch values (clients don't support oklch),
and a graceful sans/serif system font stack. The custom Inter Tight /
Source Serif 4 fonts are listed as hints but the layout reads correctly
when they're absent (most clients).


Two backends ship:

- ``LogEmailSender``: prints the email to stdout. Default for dev/QA. The
  raw token from forgot-password / verify-email shows up in the logs so
  flows are end-to-end testable without an SMTP server.
- ``SmtpEmailSender``: stdlib ``smtplib``, sync API wrapped in a thread
  executor so it's async-safe. Uses ``starttls`` by default.

Three templates per the design handoff:

- ``reset_password_email``  — 30-min link, ``no-reply@notesci.com``
- ``verify_email_email``    — 24-hr link, ``no-reply@notesci.com``
- ``invite_email``          — 14-day code, ``no-reply@notesci.com``

Callers should treat ``send()`` as best-effort: log the exception, don't
fail the HTTP request. (Exception: explicit signup / claim flows where
the user is waiting; those should surface failures.)
"""
from __future__ import annotations

import asyncio
import html
import logging
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

from .config import settings

log = logging.getLogger(__name__)


@dataclass
class Email:
    to: str
    subject: str
    text: str
    html: str | None = None
    from_address: str = "no-reply@notesci.com"


class EmailSender(Protocol):
    async def send(self, email: Email) -> None: ...


class LogEmailSender:
    """Writes the email to stdout. Used in dev / when SMTP isn't configured."""

    async def send(self, email: Email) -> None:
        log.info(
            "[email/log] from=%s to=%s subject=%r",
            email.from_address,
            email.to,
            email.subject,
        )
        for line in email.text.splitlines():
            log.info("[email/log] | %s", line)


class SmtpEmailSender:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        user: str | None,
        password: str | None,
        starttls: bool,
    ) -> None:
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.starttls = starttls

    def _send_sync(self, email: Email) -> None:
        msg = EmailMessage()
        msg["From"] = email.from_address
        msg["To"] = email.to
        msg["Subject"] = email.subject
        msg.set_content(email.text)
        if email.html:
            msg.add_alternative(email.html, subtype="html")

        with smtplib.SMTP(self.host, self.port, timeout=15) as smtp:
            if self.starttls:
                smtp.starttls(context=ssl.create_default_context())
            if self.user and self.password:
                smtp.login(self.user, self.password)
            smtp.send_message(msg)

    async def send(self, email: Email) -> None:
        await asyncio.get_running_loop().run_in_executor(
            None, self._send_sync, email
        )


def build_sender() -> EmailSender:
    if settings.notesci_email_backend == "smtp":
        if not settings.notesci_smtp_host:
            log.warning(
                "email_backend=smtp but smtp_host is not set; falling back to log sender"
            )
            return LogEmailSender()
        return SmtpEmailSender(
            host=settings.notesci_smtp_host,
            port=settings.notesci_smtp_port,
            user=settings.notesci_smtp_user,
            password=settings.notesci_smtp_password,
            starttls=settings.notesci_smtp_starttls,
        )
    return LogEmailSender()


# --- Templates --------------------------------------------------------------

# Brand-token hex approximations (email clients don't support oklch).
_BRAND_INK = "#0e1116"
_BRAND_PAPER = "#f6f4ef"
_BRAND_PAPER_2 = "#efece5"
_BRAND_INDIGO = "#4845D9"
_BRAND_MUTED = "#5a554d"
_BRAND_RULE = "rgba(14,17,22,0.12)"
_FONT_SANS = (
    "-apple-system, BlinkMacSystemFont, 'Inter Tight', 'Segoe UI', "
    "system-ui, sans-serif"
)
_FONT_SERIF = "Georgia, 'Source Serif 4', 'Times New Roman', serif"
_FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace"


def _render_html(
    *,
    title: str,
    body_paragraphs: list[str],
    cta_label: str,
    cta_url: str,
    code: str | None = None,
    footer: str = "",
) -> str:
    """Render a brand-styled transactional email body.

    All variables are HTML-escaped except the URL inside ``href``, which
    we trust because it comes from server-built links over our token /
    code formats (alphanumeric + hyphens) — no special chars to escape.
    """
    safe_title = html.escape(title)
    safe_label = html.escape(cta_label)
    safe_url = html.escape(cta_url, quote=True)
    safe_footer = html.escape(footer)

    code_chip = ""
    if code:
        safe_code = html.escape(code)
        code_chip = (
            f'<div style="margin:24px 0;padding:18px;background:{_BRAND_PAPER_2};'
            f'border-radius:10px;text-align:center;">'
            f'<div style="font-family:{_FONT_MONO};font-size:22px;'
            f'letter-spacing:0.15em;color:{_BRAND_INK};font-weight:600;'
            f'text-transform:uppercase;">{safe_code}</div>'
            f'</div>'
        )

    paragraphs_html = "".join(
        f'<p style="font-size:15px;line-height:1.55;color:{_BRAND_INK};'
        f'margin:0 0 16px;">{html.escape(p)}</p>'
        for p in body_paragraphs
    )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{safe_title}</title>
</head>
<body style="margin:0;padding:0;background:{_BRAND_PAPER};font-family:{_FONT_SANS};">
  <div style="max-width:600px;margin:0 auto;padding:48px 32px;background:{_BRAND_PAPER};">
    <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:{_BRAND_INK};margin-bottom:36px;">
      note<span style="color:{_BRAND_MUTED};font-weight:500;">sci</span>
    </div>
    <h1 style="font-family:{_FONT_SERIF};font-weight:500;font-size:28px;line-height:1.2;letter-spacing:-0.02em;color:{_BRAND_INK};margin:0 0 20px;">{safe_title}</h1>
    {paragraphs_html}
    {code_chip}
    <div style="margin:32px 0;">
      <a href="{safe_url}" style="display:inline-block;padding:14px 24px;background:{_BRAND_INK};color:{_BRAND_PAPER};text-decoration:none;border-radius:10px;font-weight:500;font-size:14px;">{safe_label}</a>
    </div>
    <p style="font-size:12px;line-height:1.5;color:{_BRAND_MUTED};margin:24px 0 0;">
      If the button doesn't work, paste this link in your browser:<br>
      <a href="{safe_url}" style="color:{_BRAND_INDIGO};word-break:break-all;">{safe_url}</a>
    </p>
    <hr style="border:none;border-top:1px solid {_BRAND_RULE};margin:40px 0 16px;">
    <p style="font-size:11px;color:{_BRAND_MUTED};margin:0;line-height:1.5;">{safe_footer}</p>
  </div>
</body>
</html>"""


def reset_password_email(*, to: str, raw_token: str) -> Email:
    link = f"{settings.notesci_app_base_url}/reset-password?token={raw_token}"
    text = (
        "Reset your notesci password\n"
        "\n"
        "Click this link within 30 minutes to set a new password:\n"
        f"{link}\n"
        "\n"
        "If you didn't request this, you can safely ignore this email.\n"
    )
    html_body = _render_html(
        title="Reset your password",
        body_paragraphs=[
            "Someone (hopefully you) asked to reset the password for your notesci account.",
            "Click below to set a new password. The link is valid for 30 minutes.",
            "If you didn't request this, you can safely ignore this email.",
        ],
        cta_label="Reset password",
        cta_url=link,
        footer=(
            f"Sent from {settings.notesci_email_from_security} because someone "
            "requested a password reset for your notesci account."
        ),
    )
    return Email(
        to=to,
        subject="Reset your notesci password",
        text=text,
        html=html_body,
        from_address=settings.notesci_email_from_security,
    )


def verify_email_email(*, to: str, raw_token: str) -> Email:
    link = f"{settings.notesci_app_base_url}/verify-email?token={raw_token}"
    text = (
        "Confirm your notesci email\n"
        "\n"
        "Click this link within 24 hours to confirm your email address:\n"
        f"{link}\n"
        "\n"
        "If you didn't sign up for notesci, ignore this email.\n"
    )
    html_body = _render_html(
        title="Confirm your email",
        body_paragraphs=[
            "Click below to confirm the email address tied to your notesci account.",
            "The link is valid for 24 hours.",
        ],
        cta_label="Confirm email",
        cta_url=link,
        footer=(
            f"Sent from {settings.notesci_email_from_invite} to confirm the address "
            "tied to your notesci account."
        ),
    )
    return Email(
        to=to,
        subject="Confirm your notesci email",
        text=text,
        html=html_body,
        from_address=settings.notesci_email_from_invite,
    )


def invite_email(*, to: str, code: str, sender_display_name: str | None = None) -> Email:
    link = f"{settings.notesci_app_base_url}/claim?c={code}"
    by = f" from {sender_display_name}" if sender_display_name else ""
    text = (
        f"You're invited to notesci{by}\n"
        "\n"
        f"Your invite code: {code}\n"
        "\n"
        "Claim your account:\n"
        f"{link}\n"
        "\n"
        "This code expires in 14 days.\n"
    )
    title = (
        f"You're invited to notesci by {sender_display_name}"
        if sender_display_name
        else "You're invited to notesci"
    )
    html_body = _render_html(
        title=title,
        body_paragraphs=[
            "notesci is invite-only during early access — a research notebook for "
            "managing scientific documents, querying them, and drafting alongside.",
            "Use the code below to claim your account. The code expires in 14 days.",
        ],
        code=code,
        cta_label="Claim my account",
        cta_url=link,
        footer=(
            f"Sent from {settings.notesci_email_from_invite} because you were "
            "invited to notesci."
        ),
    )
    return Email(
        to=to,
        subject="You're invited to notesci",
        text=text,
        html=html_body,
        from_address=settings.notesci_email_from_invite,
    )
