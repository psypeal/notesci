"""Seed (or repair) the operator's own admin account.

Idempotent. Ensures a workspace exists, ensures one admin member exists
inside it with the given password, and tops that member's invite pool
up to a target count. Safe to re-run: re-running resets the password +
forces ``role=admin``, and only generates the invite codes that are
*missing* (it never duplicates the pool).

Why this exists: workspaces aren't self-serve, and ``/auth/claim`` only
hands a brand-new member 3 invite codes. To stand up your own operator
account on a fresh VPS database — known email, known password, a large
invite pool — run this once after the stack is up.

Config — environment variables (the password has *no default* and is
required, so it never lands in source control):

    NOTESCI_SEED_ADMIN_EMAIL       default: admin@notesci.com
    NOTESCI_SEED_ADMIN_PASSWORD    REQUIRED — no default
    NOTESCI_SEED_ADMIN_NAME        default: notesci
    NOTESCI_SEED_WORKSPACE_SLUG    default: notesci
    NOTESCI_SEED_WORKSPACE_NAME    default: notesci
    NOTESCI_SEED_INVITE_COUNT      default: 50

The DB target is whatever the standard notesci settings resolve to — so
run it against local for a dev account, or inside the backend container
on the VPS for the production account:

    # local (from backend/)
    NOTESCI_SEED_ADMIN_PASSWORD='...' uv run python scripts/seed_admin.py

    # on the VPS, after `docker compose ... up -d`
    docker compose -f docker-compose.prod.yml exec \\
      -e NOTESCI_SEED_ADMIN_PASSWORD='...' \\
      backend python scripts/seed_admin.py
"""
from __future__ import annotations

import asyncio
import os
import sys

import psycopg

from notesci.auth import hash_password
from notesci.db import close_pool, get_conn
from notesci.main import _generate_invite_code


def _env(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


async def main() -> int:
    email = _env("NOTESCI_SEED_ADMIN_EMAIL", "admin@notesci.com").lower()
    password = os.environ.get("NOTESCI_SEED_ADMIN_PASSWORD", "")
    display_name = _env("NOTESCI_SEED_ADMIN_NAME", "notesci")
    ws_slug = _env("NOTESCI_SEED_WORKSPACE_SLUG", "notesci")
    ws_name = _env("NOTESCI_SEED_WORKSPACE_NAME", "notesci")
    try:
        target_invites = int(_env("NOTESCI_SEED_INVITE_COUNT", "50"))
    except ValueError:
        print("[seed] NOTESCI_SEED_INVITE_COUNT must be an integer.", file=sys.stderr)
        return 2

    if not password:
        print(
            "[seed] NOTESCI_SEED_ADMIN_PASSWORD is required (no default — so "
            "the password never lands in source control).\n"
            "  Re-run, e.g.:\n"
            "    NOTESCI_SEED_ADMIN_PASSWORD='...' uv run python scripts/seed_admin.py",
            file=sys.stderr,
        )
        return 2
    if len(password) < 8:
        print("[seed] password must be at least 8 characters.", file=sys.stderr)
        return 2
    if target_invites < 0:
        print("[seed] NOTESCI_SEED_INVITE_COUNT must be >= 0.", file=sys.stderr)
        return 2

    print(f"[seed] workspace  slug={ws_slug!r} name={ws_name!r}")
    print(f"[seed] admin      email={email!r} name={display_name!r}")
    print(f"[seed] invites    target={target_invites}")

    try:
        async with get_conn() as conn:
            async with conn.transaction():
                # 1 · workspace — upsert by slug.
                cur = await conn.execute(
                    "INSERT INTO workspaces (slug, name) VALUES (%s, %s) "
                    "ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name "
                    "RETURNING id",
                    (ws_slug, ws_name),
                )
                ws_id = (await cur.fetchone())[0]

                # 2 · member — upsert by (workspace_id, email). Re-running
                #     resets the password and forces role=admin so the
                #     account can't drift into an unusable state. xmax=0
                #     on the RETURNING row distinguishes insert vs update.
                cur = await conn.execute(
                    "INSERT INTO members "
                    "  (workspace_id, email, display_name, password_hash, "
                    "   role, email_verified_at) "
                    "VALUES (%s, %s, %s, %s, 'admin', now()) "
                    "ON CONFLICT (workspace_id, email) DO UPDATE SET "
                    "  display_name = EXCLUDED.display_name, "
                    "  password_hash = EXCLUDED.password_hash, "
                    "  role = 'admin', "
                    "  email_verified_at = "
                    "    COALESCE(members.email_verified_at, now()), "
                    "  updated_at = now() "
                    "RETURNING id, (xmax = 0) AS inserted",
                    (ws_id, email, display_name, hash_password(password)),
                )
                member_id, inserted = await cur.fetchone()

                # 3 · invite pool — top up to the target, generating only
                #     the codes that are missing. Each INSERT is its own
                #     savepoint so a (vanishingly rare) PK collision
                #     doesn't poison the outer transaction.
                cur = await conn.execute(
                    "SELECT count(*) FROM invites WHERE issuer_member_id = %s",
                    (member_id,),
                )
                existing = (await cur.fetchone())[0]
                to_make = max(0, target_invites - existing)
                made = 0
                while made < to_make:
                    for _ in range(8):
                        code = _generate_invite_code()
                        try:
                            async with conn.transaction():
                                await conn.execute(
                                    "INSERT INTO invites "
                                    "  (code, workspace_id, issuer_member_id) "
                                    "VALUES (%s, %s, %s)",
                                    (code, ws_id, member_id),
                                )
                            made += 1
                            break
                        except psycopg.errors.UniqueViolation:
                            continue
                    else:
                        print(
                            "[seed] could not allocate a unique invite code "
                            "after 8 retries — aborting.",
                            file=sys.stderr,
                        )
                        return 1
    finally:
        await close_pool()

    verb = "created" if inserted else "updated"
    print(
        f"[seed] ok — {verb} admin {email} "
        f"(member {member_id}) in workspace {ws_id}"
    )
    print(
        f"[seed] invites — {existing} existing + {made} new "
        f"= {existing + made} total issued to this account"
    )
    print("[seed] sign in at /sign-in with the email + password above.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
