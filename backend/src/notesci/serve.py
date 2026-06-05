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


# Install the policy at import time as well as in main(). The bundled
# desktop app calls main(), but import-time configuration protects helper
# invocations and keeps Windows behavior deterministic before uvicorn has
# a chance to create its server loop.
configure_windows_selector_event_loop()


def _windows_selector_loop_factory() -> asyncio.AbstractEventLoop:
    configure_windows_selector_event_loop()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    return loop


def _assert_psycopg_compatible_event_loop() -> asyncio.AbstractEventLoop:
    loop = asyncio.get_running_loop()
    if sys.platform == "win32" and "Proactor" in type(loop).__name__:
        raise RuntimeError(
            "incompatible Windows event loop: "
            f"{type(loop).__name__}. notesci must run the backend through "
            "`python -m notesci.serve` so psycopg uses a selector event loop."
        )
    return loop


async def _run_uvicorn(host: str, port: int) -> None:
    loop = _assert_psycopg_compatible_event_loop()
    print(f"notesci backend event loop: {type(loop).__name__}", file=sys.stderr, flush=True)

    import uvicorn

    config = uvicorn.Config(
        "notesci.main:app",
        host=host,
        port=port,
        server_header=False,
        loop="asyncio",
    )
    server = uvicorn.Server(config)
    await server.serve()


async def _check_event_loop() -> None:
    loop = _assert_psycopg_compatible_event_loop()
    print(f"event loop OK: {type(loop).__name__}")


def main(argv: list[str] | None = None) -> None:
    configure_windows_selector_event_loop()

    parser = argparse.ArgumentParser(description="Run the notesci desktop backend")
    parser.add_argument("--host", default=os.environ.get("NOTESCI_BACKEND_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("NOTESCI_BACKEND_PORT", "8765")),
    )
    parser.add_argument(
        "--check-event-loop",
        action="store_true",
        help="verify that the desktop launcher uses a psycopg-compatible asyncio loop",
    )
    args = parser.parse_args(argv)

    coro = _check_event_loop() if args.check_event_loop else _run_uvicorn(args.host, args.port)
    if sys.platform == "win32":
        asyncio.run(coro, loop_factory=_windows_selector_loop_factory)
    else:
        asyncio.run(coro)


if __name__ == "__main__":
    main()
