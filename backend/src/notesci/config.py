from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Defaults match backend/docker-compose.yml so local dev works without
    # a .env file. Override in production via env vars.
    database_url: str = "postgresql://notesci:notesci_dev@localhost:5433/notesci"

    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    google_api_key: str | None = None
    deepseek_api_key: str | None = None

    # Optional override for the OpenAI API endpoint. Set when the
    # OPENAI_API_KEY is issued by a third-party OpenAI-compatible proxy
    # rather than OpenAI itself.
    openai_base_url: str | None = None
    # True when the OpenAI endpoint (typically a third-party proxy)
    # serves chat completions but not embeddings. Keeps the ingest
    # pre-flight honest — ``embedding_provider_available`` reports the
    # openai provider as unavailable so uploads get a clean 400 instead
    # of a runtime failure against an endpoint with no embeddings model.
    notesci_openai_chat_only: bool = False

    # Server-side fallback model. Optional by design — we don't want to
    # impose a particular model on users. When unset, the resolver in
    # ``agent.providers`` picks the first available model based on which
    # provider key is configured. When set (operator opt-in), it's used
    # only when the caller didn't pick a model in the request.
    notesci_default_model: str | None = None

    # Embedding model. Format: "<provider>:<model_id>" — handed to LangChain's
    # init_embeddings. The chunks.embedding column is sized for this model's
    # default output dimension (1536 for text-embedding-3-small). Switching to a
    # model with a different dim requires a new migration that re-embeds.
    notesci_default_embedding: str = "openai:text-embedding-3-small"

    # Email — pluggable backend.
    #   "log"  : LogEmailSender (default; dev/QA — writes to stdout)
    #   "smtp" : SmtpEmailSender (uses the smtp_* fields below)
    notesci_email_backend: str = "log"
    notesci_smtp_host: str | None = None
    notesci_smtp_port: int = 587
    notesci_smtp_user: str | None = None
    notesci_smtp_password: str | None = None
    notesci_smtp_starttls: bool = True
    # Canonical outbound mailbox. Titan won't let the From header diverge
    # from the authenticated user unless the alternate is configured as a
    # send-as alias, so all transactional from-addresses default to the
    # single "no-reply" mailbox. Operators with multiple Titan mailboxes
    # can override per-channel here.
    notesci_email_from_invite: str = "no-reply@notesci.com"
    notesci_email_from_security: str = "no-reply@notesci.com"
    # Public URL used to build links in email bodies. Override for prod.
    notesci_app_base_url: str = "http://localhost:8000"

    # Admin endpoints (workspace bootstrap) require this token in the
    # X-Admin-Token header. When unset, those endpoints return 503.
    # Generate with: python -c "import secrets; print(secrets.token_urlsafe(32))"
    notesci_admin_token: str | None = None

    # Single-user desktop mode. When True the lifespan auto-bootstraps a
    # default workspace + member on first launch and writes a session
    # token to ``notesci_local_token_path``. The Tauri shell reads that
    # file and injects the token into the WebView's localStorage so the
    # user never sees a sign-in screen. Set by the Tauri launcher; leave
    # off in dev / multi-user deployments.
    notesci_local_mode: bool = False
    notesci_local_token_path: str = "/var/lib/notesci/session_token"

    # Sweeper interval (seconds) for the periodic cleanup task spawned by
    # lifespan. Set to 0 to disable the loop entirely (useful for tests).
    notesci_sweep_interval_seconds: int = 3600

    # Disable per-IP rate limiting entirely. Only intended for the test
    # suite where multiple fixtures hammer /auth/claim + /auth/signin
    # from the same loopback peer. Never enable in production.
    notesci_disable_rate_limits: bool = False

    # Comma-separated list of CORS-allowed origins. Defaults to the Vite
    # dev server. In prod set to the user-facing https origin.
    notesci_allowed_origins: str = "http://localhost:5173"

    # Comma-separated list of trusted-proxy CIDRs. When the direct peer
    # is in one of these, the rate limiter trusts the leftmost
    # ``X-Forwarded-For`` address; otherwise it uses ``request.client.host``.
    notesci_trusted_proxies: str = "127.0.0.1/8,::1/128"

    # Symmetric key (Fernet, 32 url-safe-base64 bytes) used to encrypt
    # MCP config secrets at rest. Optional in dev — when unset the
    # crypto helpers log a warning at startup and store plaintext.
    notesci_secret_key: str | None = None

    # PageIndex tree-build feature flag. When True, the PDF ingestion
    # pipeline runs a tree builder after the vector pipeline finishes
    # and stores the result in ``material_trees``. When False (default),
    # PDFs are only chunked + embedded; the chat retrieval stays on the
    # vector path. The build is LLM-expensive (often dozens of calls per
    # PDF) — flip on only when the cost story is acceptable.
    notesci_pagetree_enabled: bool = False
    # Max pages — skip tree build for PDFs larger than this. LLM cost
    # grows super-linearly past ~200 pages and the marginal value of a
    # tree for very long docs starts to fall off.
    notesci_pagetree_max_pages: int = 200
    # Model override for tree build. Defaults to ``notesci_default_model``
    # when unset. Routed via ``make_chat_model``.
    notesci_pagetree_model: str | None = None

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip() for o in self.notesci_allowed_origins.split(",") if o.strip()]

    @property
    def trusted_proxies(self) -> list[str]:
        return [c.strip() for c in self.notesci_trusted_proxies.split(",") if c.strip()]


settings = Settings()


def _export_provider_keys_to_env() -> None:
    """Mirror loaded provider credentials into ``os.environ``.

    Pydantic-settings reads ``.env`` into the ``Settings`` instance, but
    LangChain's ``init_chat_model`` (and the underlying provider classes:
    ``ChatAnthropic``, ``ChatOpenAI``, ``ChatGoogleGenerativeAI``,
    ``ChatDeepSeek``) read their API keys from ``os.environ`` directly.
    Without this bridge a key set only in ``.env`` (the standard recipe
    in this repo) would be invisible to the provider clients and they
    would raise "API_KEY must be set" at construction time.

    Only sets variables that aren't already in ``os.environ`` so a
    deliberately-set OS env var still wins (matters for prod overrides
    via Docker / systemd).
    """
    import os
    for env_name, value in (
        ("ANTHROPIC_API_KEY", settings.anthropic_api_key),
        ("OPENAI_API_KEY", settings.openai_api_key),
        ("GOOGLE_API_KEY", settings.google_api_key),
        ("DEEPSEEK_API_KEY", settings.deepseek_api_key),
        # The OpenAI SDK natively honours OPENAI_BASE_URL, so bridging it
        # here is all that's needed to route chat + embeddings through a
        # third-party OpenAI-compatible proxy.
        ("OPENAI_BASE_URL", settings.openai_base_url),
    ):
        if value and not os.environ.get(env_name):
            os.environ[env_name] = value


_export_provider_keys_to_env()
