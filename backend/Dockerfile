# Multi-stage build: tiny final image (~250 MB) with only the runtime
# Python venv + app source + migrations. uv handles the venv creation
# in the builder stage; the runtime stage just copies the venv over.
#
# The backend listens on $PORT (default 8000). DB migrations + LangGraph
# checkpointer setup run on startup via the FastAPI lifespan handler —
# nothing to do at image build time.

ARG PYTHON_VERSION=3.12

# ---------- builder ----------
FROM python:${PYTHON_VERSION}-slim AS builder

# uv is the package + project manager (matches local dev). Pin a version
# so the lockfile is honoured deterministically; bump intentionally.
COPY --from=ghcr.io/astral-sh/uv:0.5.6 /uv /uvx /bin/

# Build deps for any packages that ship sdist-only on aarch64 (psycopg
# binary wheel covers most cases on amd64; keep gcc here as a safety net).
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_INSTALLER_METADATA=1

# Install deps first (cached) — only the lockfile + manifest, then code.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Now copy the project and finish the install (in-tree wheel).
COPY src/ ./src/
COPY db/ ./db/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# Operational one-shot scripts (seed_admin, test_smtp) — run inside the
# container post-deploy, e.g. `docker compose exec backend python
# scripts/seed_admin.py`. Copied after the install so they don't bust
# the dependency cache layer.
COPY scripts/ ./scripts/

# ---------- runtime ----------
FROM python:${PYTHON_VERSION}-slim AS runtime

# libpq for psycopg's runtime; everything else lives in the venv.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Non-root user — minimises blast radius if a sandbox escape ever lands.
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app

COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER app
EXPOSE 8000

# Default to uvicorn directly (production), not `fastapi dev` (which
# adds a watcher + reloader). Workers tuned for a small VPS — bump on
# bigger boxes via the entrypoint command.
CMD ["uvicorn", "notesci.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--proxy-headers", \
     "--forwarded-allow-ips=*"]

# Liveness probe — same /health endpoint the LB uses. Lifespan-failed
# starts (bad migration, DB unreachable) trip this and Compose restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1
