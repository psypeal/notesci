"""Symmetric encryption helpers for MCP config secrets.

Encrypts the sensitive sub-fields of ``mcp_servers.config`` (``headers``
and ``env``) at rest. The runtime config consumed by ``mcp_tools.py``
sees the decrypted values; the API surface (``GET /mcp/servers``) only
ever shows redacted placeholders so the dashboard can render a
"configured" state without leaking the secret material.

Key management is deliberately simple for the invite-only beta:

  * ``NOTESCI_SECRET_KEY`` env (32 url-safe-base64 bytes) is the master
    key. Generate with::

        python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

  * If unset, ``get_fernet()`` returns ``None`` and the helpers
    transparently fall back to plaintext storage with a log warning at
    startup. This keeps local dev frictionless.
"""
from __future__ import annotations

import logging
import os
from typing import Iterable

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger(__name__)

_ENV_VAR = "NOTESCI_SECRET_KEY"
_ENCRYPTED_PREFIX = "fernet:"

# Keys inside an MCP ``config.headers`` dict that we treat as secret
# (case-insensitive). Used by the API redactor.
_SECRET_HEADER_RE_PARTS = (
    r"^authorization$",
    r"^api[_-]?key$",
    r"^token$",
    r"^secret$",
    r"^password$",
    r"^x-api-key$",
)


def _key_from_env() -> bytes | None:
    raw = os.environ.get(_ENV_VAR)
    if not raw:
        return None
    return raw.encode("utf-8")


_fernet: Fernet | None = None
_fernet_loaded = False


def get_fernet() -> Fernet | None:
    """Return a memoised Fernet instance or ``None`` if the key is unset.

    Callers should branch on ``None`` and store/return plaintext when no
    key is configured (the deploy doc warns this is unsafe outside dev).

    Hard-fails in production: when ``NOTESCI_ENV=prod`` and the key is
    missing or unparseable, raises ``RuntimeError`` so the process
    refuses to start rather than silently store secrets in plaintext.
    """
    global _fernet, _fernet_loaded
    if not _fernet_loaded:
        _fernet_loaded = True
        env = os.environ.get("NOTESCI_ENV", "dev").lower()
        key = _key_from_env()
        if key is None:
            if env == "prod":
                raise RuntimeError(
                    f"{_ENV_VAR} must be set in production"
                )
            log.warning(
                "%s not set — MCP secrets will be stored in plaintext. "
                "Generate one with `python -c \"from cryptography.fernet "
                "import Fernet; print(Fernet.generate_key().decode())\"`",
                _ENV_VAR,
            )
            _fernet = None
        else:
            try:
                _fernet = Fernet(key)
            except Exception as e:
                if env == "prod":
                    raise RuntimeError(
                        f"invalid {_ENV_VAR}: {e}"
                    ) from e
                log.error("invalid %s — encryption disabled: %s", _ENV_VAR, e)
                _fernet = None
    return _fernet


def encrypt_str(plain: str) -> str:
    """Encrypt ``plain`` if a Fernet key is configured, else return as-is.

    Encrypted values carry a ``fernet:`` prefix so ``decrypt_str`` can
    distinguish them from legacy plaintext on read.
    """
    f = get_fernet()
    if f is None:
        return plain
    return _ENCRYPTED_PREFIX + f.encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_str(value: str) -> str:
    """Decrypt ``value`` produced by :func:`encrypt_str`.

    Plaintext values (no ``fernet:`` prefix) are returned unchanged so
    rows written before the key was configured keep working.
    """
    if not isinstance(value, str) or not value.startswith(_ENCRYPTED_PREFIX):
        return value
    f = get_fernet()
    if f is None:
        # Encrypted token but no key configured — refuse to leak the
        # ciphertext to the runtime config. Caller should treat as
        # missing/empty.
        log.error("encrypted MCP value present but %s is unset", _ENV_VAR)
        return ""
    payload = value[len(_ENCRYPTED_PREFIX):].encode("ascii")
    try:
        return f.decrypt(payload).decode("utf-8")
    except InvalidToken:
        log.exception("InvalidToken decrypting MCP value")
        return ""


def encrypt_mapping(d: dict | None) -> dict:
    """Encrypt every string value in ``d``. Non-string values pass through."""
    if not d:
        return {}
    out: dict = {}
    for k, v in d.items():
        if isinstance(v, str):
            out[k] = encrypt_str(v)
        else:
            out[k] = v
    return out


def decrypt_mapping(d: dict | None) -> dict:
    if not d:
        return {}
    out: dict = {}
    for k, v in d.items():
        if isinstance(v, str):
            out[k] = decrypt_str(v)
        else:
            out[k] = v
    return out


import re as _re

_SECRET_HEADER_RES = tuple(_re.compile(p, _re.IGNORECASE) for p in _SECRET_HEADER_RE_PARTS)


def _looks_secret(header_name: str) -> bool:
    return any(rx.match(header_name) for rx in _SECRET_HEADER_RES)


def encrypt_config_secrets(config: dict | None) -> dict:
    """Return a copy of ``config`` with ``headers`` and ``env`` values
    encrypted in place. Other keys (url, command, args, cwd) are left
    alone since they're not secret in the typical MCP transport configs
    we ship.
    """
    if not config:
        return {}
    out = dict(config)
    if isinstance(out.get("headers"), dict):
        out["headers"] = encrypt_mapping(out["headers"])
    if isinstance(out.get("env"), dict):
        out["env"] = encrypt_mapping(out["env"])
    return out


def decrypt_config_secrets(config: dict | None) -> dict:
    """Inverse of :func:`encrypt_config_secrets`. Returns a runtime-ready
    config dict that ``mcp_tools.py`` can pass to the MCP client.
    """
    if not config:
        return {}
    out = dict(config)
    if isinstance(out.get("headers"), dict):
        out["headers"] = decrypt_mapping(out["headers"])
    if isinstance(out.get("env"), dict):
        out["env"] = decrypt_mapping(out["env"])
    return out


_REDACTED = "***"


def _looks_like_ciphertext(value: object) -> bool:
    """Defense-in-depth check for a value that *might* be a Fernet ciphertext.

    Catches both our prefixed form (``fernet:...``) and a bare Fernet
    token (the base64 envelope always starts ``gAAAAA`` because the
    version byte is 0x80 and the timestamp's high bits are zero).
    """
    if not isinstance(value, str):
        return False
    return value.startswith(_ENCRYPTED_PREFIX) or value.startswith("gAAAAA")


def redact_config_for_api(config: dict | None) -> dict:
    """Return an API-safe view of ``config``.

    Header values matching the secret regex are replaced with
    ``"***"``; the entire ``env`` map is replaced with redacted values
    (every key is treated as secret for stdio servers). The shape stays
    identical so the UI can still render which keys are configured.

    Defense-in-depth: any header value that *looks* like an encrypted
    secret (Fernet ``fernet:`` prefix or bare ``gAAAAA`` ciphertext) is
    redacted even if the header name slipped past the secret regex.
    Ciphertext leaking out a public API is harmless (without the key it
    can't be decrypted) but it's a tell that something is misconfigured,
    so we hide it.
    """
    if not config:
        return {}
    out = dict(config)
    headers = out.get("headers")
    if isinstance(headers, dict):
        out["headers"] = {
            k: (
                _REDACTED
                if _looks_secret(str(k)) or _looks_like_ciphertext(v)
                else v
            )
            for k, v in headers.items()
        }
    env = out.get("env")
    if isinstance(env, dict):
        out["env"] = {k: _REDACTED for k in env}
    return out


__all__: Iterable[str] = (
    "decrypt_config_secrets",
    "decrypt_mapping",
    "decrypt_str",
    "encrypt_config_secrets",
    "encrypt_mapping",
    "encrypt_str",
    "get_fernet",
    "redact_config_for_api",
)
