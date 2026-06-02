"""Sliding-window rate limiter, Postgres-backed.

Used to throttle auth endpoints (sign-in, claim, forgot-password,
waitlist). Each request acquires/updates a row in ``rate_limits`` keyed
by ``"<endpoint>:<client_ip>"``. The window is fixed-length: when it
elapses, the counter resets.

Limitations (acceptable for the invite-only beta):
- Single-row contention per (endpoint, ip). Fine at beta volume.
- Stale rows are not swept; the table is bounded by unique IPs *
  endpoint keys, which stays small.
"""
from __future__ import annotations

import ipaddress
import logging
from datetime import datetime, timezone

from fastapi import HTTPException, Request

from .config import settings
from .db import get_conn

log = logging.getLogger(__name__)


async def check_and_increment(
    *, key: str, limit: int, window_seconds: int = 60
) -> bool:
    """Return ``True`` if allowed, ``False`` if the request should be denied.

    The counter is incremented atomically when allowed.
    """
    async with get_conn() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "SELECT count, window_start FROM rate_limits "
                "WHERE bucket_key=%s FOR UPDATE",
                (key,),
            )
            row = await cur.fetchone()
            now = datetime.now(timezone.utc)

            if row is None:
                await conn.execute(
                    "INSERT INTO rate_limits (bucket_key, count, window_start) "
                    "VALUES (%s, 1, %s)",
                    (key, now),
                )
                return True

            count, window_start = row
            elapsed = (now - window_start).total_seconds()
            if elapsed >= window_seconds:
                await conn.execute(
                    "UPDATE rate_limits SET count=1, window_start=%s "
                    "WHERE bucket_key=%s",
                    (now, key),
                )
                return True

            if count >= limit:
                return False

            await conn.execute(
                "UPDATE rate_limits SET count=count+1 WHERE bucket_key=%s",
                (key,),
            )
            return True


def _parse_proxy_nets() -> list[ipaddress._BaseNetwork]:
    """Parse ``settings.trusted_proxies`` into network objects.

    Invalid entries are skipped with a warning rather than raising —
    operators shouldn't have a 500-spewing service over a typo.
    """
    nets: list[ipaddress._BaseNetwork] = []
    for cidr in settings.trusted_proxies:
        try:
            nets.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            log.warning("ignoring invalid trusted_proxy CIDR: %s", cidr)
    return nets


_TRUSTED_PROXY_NETS: list[ipaddress._BaseNetwork] | None = None


def _trusted_proxy_nets() -> list[ipaddress._BaseNetwork]:
    global _TRUSTED_PROXY_NETS
    if _TRUSTED_PROXY_NETS is None:
        _TRUSTED_PROXY_NETS = _parse_proxy_nets()
    return _TRUSTED_PROXY_NETS


def _client_ip(request: Request) -> str:
    """Resolve the originating IP for rate limiting.

    Honors ``X-Forwarded-For`` only when the direct peer is in one of
    the trusted-proxy CIDRs (default ``127.0.0.1/8,::1/128``). In that
    case, takes the LEFTMOST address from the header (the original
    client per RFC 7239 — middle hops only append). Otherwise falls
    back to ``request.client.host`` so a spoofed header from an
    untrusted peer can't recolour the rate-limit key.
    """
    peer = request.client.host if request.client and request.client.host else None
    if not peer:
        return "unknown"
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return peer
    nets = _trusted_proxy_nets()
    if any(peer_ip in n for n in nets):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            leftmost = xff.split(",")[0].strip()
            if leftmost:
                # Validate it parses as an IP; otherwise fall back.
                try:
                    ipaddress.ip_address(leftmost)
                    return leftmost
                except ValueError:
                    pass
    return peer


async def enforce(
    request: Request,
    *,
    endpoint: str,
    limit: int,
    window_seconds: int = 60,
    member_id: object | None = None,
) -> None:
    """Raise ``HTTPException(429)`` when the per-IP limit for this endpoint is hit.

    Disabled entirely when ``NOTESCI_DISABLE_RATE_LIMITS=true`` — used by
    the test suite so that fixtures can claim multiple invites + sign in
    repeatedly from the same loopback peer without tripping the 10/min cap.

    When ``member_id`` is set, the bucket key is namespaced by member id
    instead of client IP — appropriate for authenticated endpoints
    (e.g. PAT creation) where the per-member quota is the real limit.
    """
    if settings.notesci_disable_rate_limits:
        return
    if member_id is not None:
        key = f"{endpoint}:m:{member_id}"
    else:
        key = f"{endpoint}:{_client_ip(request)}"
    if not await check_and_increment(
        key=key, limit=limit, window_seconds=window_seconds
    ):
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited"},
            headers={"Retry-After": str(window_seconds)},
        )
