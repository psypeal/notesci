"""Auth primitives: password hashing, opaque session tokens, FastAPI dep.

Tokens are 256-bit ``secrets.token_urlsafe`` strings. Only their sha256
hash is persisted (in ``auth_sessions.token_hash``) so a DB leak does not
grant access. Clients send the raw token in the ``Authorization: Bearer``
header.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

import argon2
import psycopg
from argon2 import PasswordHasher
from fastapi import Header, HTTPException

from .db import get_conn

log = logging.getLogger(__name__)

SESSION_TTL = timedelta(days=30)
RESET_TOKEN_TTL = timedelta(minutes=30)
VERIFY_TOKEN_TTL = timedelta(hours=24)
TOKEN_BYTES = 32  # 256 bits

_hasher = PasswordHasher()

# Pre-computed dummy hash used by `dummy_verify_password` to equalize
# the response time of "no such email" with "wrong password" in /auth/signin.
# Computed once at import time so per-request cost is just one verify().
_DUMMY_HASH = _hasher.hash("notesci-dummy-password-do-not-use")


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        _hasher.verify(hashed, plain)
        return True
    except argon2.exceptions.Argon2Error:
        # Covers VerifyMismatchError, InvalidHash, InvalidHashError —
        # anything argon2 considers a verification failure should be
        # treated as a wrong password rather than a server error.
        return False


def dummy_verify_password(plain: str) -> None:
    """Burn an argon2 verify() against a fixed dummy hash.

    Called by /auth/signin on the "email not found" branch so an attacker
    can't distinguish "unknown email" from "wrong password" by response
    timing. Result is intentionally discarded.
    """
    try:
        _hasher.verify(_DUMMY_HASH, plain)
    except argon2.exceptions.Argon2Error:
        pass


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def mint_session(
    conn: psycopg.AsyncConnection, member_id: UUID
) -> tuple[str, datetime]:
    """Create an ``auth_sessions`` row, return ``(raw_token, expires_at)``."""
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    expires = datetime.now(timezone.utc) + SESSION_TTL
    await conn.execute(
        "INSERT INTO auth_sessions (token_hash, member_id, expires_at) VALUES (%s, %s, %s)",
        (hash_token(raw), member_id, expires),
    )
    return raw, expires


@dataclass
class CurrentMember:
    id: UUID
    workspace_id: UUID
    email: str
    display_name: str | None
    role: str


async def current_member(
    authorization: str | None = Header(default=None),
) -> CurrentMember:
    """FastAPI dependency: resolve the caller's session or PAT to a member.

    TOCTOU note: token validation runs exactly once per request, at the
    dependency-resolution step. If the same token is revoked while the
    request body is mid-flight, the action still completes — the
    snapshot taken here outlives the revoke. This is acceptable for the
    beta because: (1) the window is bounded by request duration (~1s
    for sync endpoints, up to ~chat-streaming-budget for /chat); (2)
    revocation is a deliberate action and the user already considers
    the cred compromised, so a few extra seconds of access doesn't
    change the threat model; (3) closing the window would require a
    per-statement re-validation that adds a DB round-trip to every
    query. Revisit once we ship streaming auth (websockets) where the
    window is unbounded.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="empty bearer token")

    th = hash_token(token)
    th_bytes = bytes.fromhex(th)  # auth_tokens.token_hash is BYTEA
    async with get_conn() as conn:
        # Try short-lived web sessions first (most common).
        cur = await conn.execute(
            """
            SELECT m.id, m.workspace_id, m.email, m.display_name, m.role,
                   s.expires_at
            FROM auth_sessions s JOIN members m ON m.id = s.member_id
            WHERE s.token_hash = %s
            """,
            (th,),
        )
        row = await cur.fetchone()
        if row:
            if row[5] <= datetime.now(timezone.utc):
                await conn.execute(
                    "DELETE FROM auth_sessions WHERE token_hash=%s", (th,)
                )
                await conn.commit()
                raise HTTPException(status_code=401, detail="token expired")
            # Debounce the telemetry write — see note above.
            try:
                await conn.execute(
                    "UPDATE auth_sessions SET last_seen_at=now() "
                    "WHERE token_hash=%s "
                    "  AND last_seen_at < now() - interval '60 seconds'",
                    (th,),
                )
                await conn.commit()
            except Exception:
                log.warning("session touch failed", exc_info=True)
            return CurrentMember(
                id=row[0],
                workspace_id=row[1],
                email=row[2],
                display_name=row[3],
                role=row[4],
            )

        # Fall through to PATs (personal access tokens).
        cur = await conn.execute(
            """
            SELECT m.id, m.workspace_id, m.email, m.display_name, m.role,
                   t.expires_at, t.revoked_at
            FROM auth_tokens t JOIN members m ON m.id = t.member_id
            WHERE t.token_hash = %s
            """,
            (th_bytes,),
        )
        prow = await cur.fetchone()
        if not prow:
            raise HTTPException(status_code=401, detail="invalid token")
        if prow[6] is not None:
            raise HTTPException(status_code=401, detail="token revoked")
        if prow[5] is not None and prow[5] <= datetime.now(timezone.utc):
            raise HTTPException(status_code=401, detail="token expired")
        try:
            await conn.execute(
                "UPDATE auth_tokens SET last_used_at=now() "
                "WHERE token_hash=%s "
                "  AND (last_used_at IS NULL "
                "       OR last_used_at < now() - interval '60 seconds')",
                (th_bytes,),
            )
            await conn.commit()
        except Exception:
            log.warning("token touch failed", exc_info=True)
        return CurrentMember(
            id=prow[0],
            workspace_id=prow[1],
            email=prow[2],
            display_name=prow[3],
            role=prow[4],
        )


async def signout(token: str) -> None:
    async with get_conn() as conn:
        await conn.execute(
            "DELETE FROM auth_sessions WHERE token_hash=%s", (hash_token(token),)
        )
        await conn.commit()


# ---------------------------------------------------------------------------
# Single-use tokens — password reset (30 min) + email verification (24 h).
# Both share the "opaque token, sha256 at rest, single-use, time-bounded"
# pattern. They live in distinct tables because they have different TTLs
# and side-effects on consume.
# ---------------------------------------------------------------------------


async def mint_password_reset_token(
    conn: psycopg.AsyncConnection, member_id: UUID
) -> str:
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    expires = datetime.now(timezone.utc) + RESET_TOKEN_TTL
    await conn.execute(
        "INSERT INTO password_reset_tokens (token_hash, member_id, expires_at) "
        "VALUES (%s, %s, %s)",
        (hash_token(raw), member_id, expires),
    )
    return raw


async def mint_email_verify_token(
    conn: psycopg.AsyncConnection, member_id: UUID
) -> str:
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    expires = datetime.now(timezone.utc) + VERIFY_TOKEN_TTL
    await conn.execute(
        "INSERT INTO email_verification_tokens (token_hash, member_id, expires_at) "
        "VALUES (%s, %s, %s)",
        (hash_token(raw), member_id, expires),
    )
    return raw


async def _consume_token(
    conn: psycopg.AsyncConnection, table: str, raw: str
) -> UUID | None:
    """Mark a single-use token as used and return its member_id, or None
    if invalid / expired / already consumed."""
    th = hash_token(raw)
    cur = await conn.execute(
        f"SELECT member_id, expires_at, used_at FROM {table} "
        f"WHERE token_hash=%s FOR UPDATE",
        (th,),
    )
    row = await cur.fetchone()
    if not row:
        return None
    member_id, expires_at, used_at = row
    if used_at is not None or expires_at <= datetime.now(timezone.utc):
        return None
    await conn.execute(
        f"UPDATE {table} SET used_at=now() WHERE token_hash=%s", (th,)
    )
    return member_id


async def consume_password_reset_token(
    conn: psycopg.AsyncConnection, raw: str
) -> UUID | None:
    return await _consume_token(conn, "password_reset_tokens", raw)


async def consume_email_verify_token(
    conn: psycopg.AsyncConnection, raw: str
) -> UUID | None:
    return await _consume_token(conn, "email_verification_tokens", raw)
