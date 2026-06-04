"""Uvicorn launcher for the bundled desktop backend.

Windows defaults to ProactorEventLoop, but psycopg's async connections
require a selector-compatible asyncio loop. This module is intentionally
used as the desktop entrypoint instead of ``python -m uvicorn`` so the
policy is set before uvicorn creates the server loop.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys


def configure_windows_selector_event_loop() -> None:
    if sys.platform != "win32":
        return
    policy_cls = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if policy_cls is not None:
        asyncio.set_event_loop_policy(policy_cls())


def main(argv: list[str] | None = None) -> None:
    configure_windows_selector_event_loop()

    parser = argparse.ArgumentParser(description="Run the notesci desktop backend")
    parser.add_argument("--host", default=os.environ.get("NOTESCI_BACKEND_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("NOTESCI_BACKEND_PORT", "8765")),
    )
    args = parser.parse_args(argv)

    import uvicorn

    uvicorn.run(
        "notesci.main:app",
        host=args.host,
        port=args.port,
        server_header=False,
    )


if __name__ == "__main__":
    main()
