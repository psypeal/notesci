"""Curated MCP marketplace catalog.

Single source of truth for the dashboard's MCP browse page. Each entry
ships with the real install template (``transport`` + ``config``) the
user gets when they click Install — no manual JSON to write. Some
entries are marked ``available=False`` when the MCP server doesn't yet
exist publicly; those render in the marketplace with a "coming soon"
state and don't actually call ``POST /mcp/servers``.

The frontend used to keep this list inline. Moving it to the backend
means a release ships new servers without a frontend redeploy, and
gives us a single place to track which servers are actually wired.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class CatalogField:
    """UI form field for source-style connectors.

    These are used by the Sources page to render a connector-specific
    install/configure form from the catalog rather than hard-coding each
    connector in the frontend.
    """

    label: str
    path: str
    placeholder: str | None = None
    secret: bool = False
    help_url: str | None = None


def _field_label_from_key(key: str) -> str:
    cleaned = key.strip().replace("_", " ").replace("-", " ").title()
    return cleaned if cleaned else key


def _looks_secret_var(name: str) -> bool:
    n = name.lower()
    return "token" in n or "secret" in n or "key" in n or "password" in n or "api" in n


def _dedupe_fields(fields: list[CatalogField]) -> tuple[CatalogField, ...]:
    seen: set[str] = set()
    out: list[CatalogField] = []
    for f in fields:
        if f.path in seen:
            continue
        seen.add(f.path)
        out.append(f)
    return tuple(out)


def _source_fields_from_config(
    config: dict,
    required_secrets: list[str] | None = None,
) -> tuple[CatalogField, ...]:
    fields: list[CatalogField] = []
    headers = config.get("headers") if isinstance(config, dict) else None
    if isinstance(headers, dict):
        for key in sorted(headers):
            if not isinstance(key, str):
                continue
            path = f"headers.{key}"
            fields.append(
                CatalogField(
                    label=_field_label_from_key(key),
                    path=path,
                    placeholder="Bearer …",
                    secret=_looks_secret_var(key),
                )
            )

    env = config.get("env") if isinstance(config, dict) else None
    if isinstance(env, dict):
        for key in sorted(env):
            if not isinstance(key, str):
                continue
            fields.append(
                CatalogField(
                    label=_field_label_from_key(key),
                    path=f"env.{key}",
                    placeholder=None,
                    secret=_looks_secret_var(key),
                )
            )

    for name in required_secrets or []:
        path = f"env.{name}"
        if path in {f.path for f in fields}:
            continue
        fields.append(
            CatalogField(
                label=_field_label_from_key(name),
                path=path,
                secret=True,
            )
        )

    return _dedupe_fields(fields)


Category = Literal[
    "Featured", "Research", "Writing", "Data",
    "Productivity", "Code", "Web", "Lab tools",
]


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    name: str
    category: Category
    author: str
    description: str
    rating: float
    installs: str
    featured: bool = False
    official: bool = False
    available: bool = True
    # Icon slug — the frontend maps this to a per-server SVG glyph.
    # Left blank here and resolved to the entry ``id`` at the API
    # boundary, so each server gets a distinct mark for free; set it
    # explicitly only when an entry should reuse another's glyph.
    icon: str = ""
    # Optional install-time disclaimer. When non-empty, the marketplace
    # shows this text in a modal the user must explicitly acknowledge
    # before the install proceeds — used for legally-grey servers so the
    # risk sits with the user, not the operator.
    disclaimer: str = ""
    transport: Literal["http", "stdio", "sse"] = "http"
    # Per-transport config blob. Same shape used by `mcp_servers.config`
    # in the DB. The frontend echoes this on install — no editing UI yet.
    config: dict = field(default_factory=dict)
    # Tools the agent gets when this server is installed with the
    # default starter grants. Frontend uses this for the install
    # confirmation card; backend stores it in `mcp_servers.grants`.
    default_grants: dict = field(default_factory=dict)
    # Set of catalog entries that should render on Settings → Sources.
    show_in_sources: bool = False
    # Optional source-page form fields (for credentialed connectors). The
    # order is used directly by the UI.
    source_fields: tuple[CatalogField, ...] = field(default_factory=tuple)


def _allow_all() -> dict:
    """Default grants — agent can call any tool the server exposes.

    Users can later switch to an explicit allowlist via the Installed
    MCPs page (PATCH /mcp/servers/{id}).
    """
    return {"allowAll": True, "tools": [], "deniedTools": []}


CATALOG: tuple[CatalogEntry, ...] = (
    CatalogEntry(
        id="semantic-scholar",
        name="Semantic Scholar",
        category="Research",
        author="hy20191108/semantic-scholar-mcp",
        description="Full-text search over 200M+ papers, citation graph, author lookup.",
        rating=4.9,
        installs="42k",
        featured=True,
        official=False,
        # Community MCP server (semantic-scholar-mcp) over the Semantic
        # Scholar API — run via uvx so no manual install is needed.
        # The previous entry was an http transport pointed at
        # api.semanticscholar.org/graph/v1/mcp, which is the REST API,
        # not an MCP endpoint: it returned 405 and yielded zero tools,
        # so the agent saw no Scholar tools at all.
        transport="stdio",
        config={
            "command": "uvx",
            "args": ["semantic-scholar-mcp"],
            "env": {},
        },
        show_in_sources=True,
        source_fields=(),
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="arxiv",
        name="arXiv",
        category="Research",
        author="arxiv-mcp-server",
        description="Search arXiv by title, author, or category. Fetch PDFs and abstracts.",
        rating=4.8,
        installs="38k",
        featured=True,
        official=True,
        transport="stdio",
        config={
            "command": "uvx",
            "args": ["arxiv-mcp-server"],
            "env": {},
        },
        # ArXiv may be useful for research workflows, but only when
        # explicitly enabled by the operator as a source.
        show_in_sources=True,
        source_fields=(),
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="pubmed",
        name="PubMed",
        category="Research",
        author="andybrandt/mcp-simple-pubmed",
        description="Biomedical literature search over PubMed via the NCBI Entrez API — abstracts, MeSH terms, full-text links.",
        rating=4.7,
        installs="24k",
        featured=True,
        official=True,
        # Community MCP server (mcp-simple-pubmed) — talks to NCBI's
        # Entrez API. Run via uvx so no manual install is needed.
        # PUBMED_EMAIL is required by NCBI's API usage policy and the
        # server refuses to start without it — the install endpoint
        # auto-fills it with the installing member's email (see
        # ``_seed_catalog_config``), so the empty string here is just a
        # placeholder that's always replaced.
        transport="stdio",
        config={
            "command": "uvx",
            "args": [
                "--from",
                "mcp-simple-pubmed",
                "python",
                "-m",
                "mcp_simple_pubmed",
            ],
            "env": {"PUBMED_EMAIL": ""},
        },
        show_in_sources=True,
        source_fields=(
            CatalogField(
                label="Email for NCBI courtesy contact",
                path="env.PUBMED_EMAIL",
                placeholder="you@institution.edu",
                secret=False,
            ),
        ),
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="paper-search",
        name="Paper Search",
        category="Research",
        author="paper-search-mcp",
        description="Federated search across 14 databases (Scholar, bioRxiv, OpenAlex, CORE, DOAJ, Crossref, Europe PMC, ...). Uses managed Node 20 via npx for compatibility.",
        rating=4.6,
        installs="19k",
        transport="stdio",
        config={
            "command": "npx",
            "args": [
                "-y",
                "--package",
                "node@20",
                "--package",
                "paper-search-mcp-nodejs",
                "paper-search-mcp-nodejs",
            ],
            "env": {},
        },
        show_in_sources=True,
        source_fields=(),
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="consensus",
        name="Consensus",
        category="Research",
        author="consensus.app",
        description="Evidence-backed answers from 200M+ academic papers — search by question, get a synthesized consensus.",
        rating=4.7,
        installs="16k",
        featured=True,
        official=True,
        transport="http",
        config={"url": "https://mcp.consensus.app/mcp"},
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="scihub",
        name="Sci-Hub",
        category="Research",
        author="Debvex/sci-hub-mcp-server",
        # Honest framing: Sci-Hub routes around publisher paywalls and
        # its legal status varies by jurisdiction. Surfaced because the
        # reference research plugin includes it, but kept un-featured
        # and gated behind an install-time disclaimer the user must
        # explicitly accept (see ``disclaimer`` below).
        description="Retrieve papers by DOI. Routes around publisher paywalls — legal status varies by jurisdiction; you are responsible for compliance.",
        rating=4.2,
        installs="7k",
        official=False,
        available=True,
        disclaimer=(
            "Sci-Hub retrieves research papers by routing around publisher "
            "paywalls. Its legality varies by jurisdiction. notesci does not "
            "host or mirror any Sci-Hub content — installing this only "
            "configures a third-party community MCP server in your "
            "workspace. You are solely responsible for ensuring your use "
            "complies with copyright law where you operate. notesci and its "
            "operators disclaim all liability arising from use of this "
            "server. You can uninstall it at any time from the Installed "
            "page."
        ),
        transport="stdio",
        config={
            "command": "uvx",
            "args": [
                "--from",
                "sci-hub-mcp-server",
                "sci-hub-mcp-server",
            ],
            "env": {"PYTHONUTF8": "1"},
        },
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="huggingface",
        name="HuggingFace Hub",
        category="Data",
        author="huggingface",
        description="Browse datasets and models; pull README and metadata.",
        rating=4.5,
        installs="31k",
        featured=True,
        official=True,
        # HuggingFace's official hosted MCP endpoint. The previous entry
        # was a stdio `npx @huggingface/mcp-server`, which doesn't exist
        # on npm (404). The hosted endpoint works anonymously for public
        # data; HF_TOKEN unlocks private/rate-limited access.
        transport="http",
        config={
            "url": "https://huggingface.co/mcp",
            "headers": {"Authorization": "Bearer ${HF_TOKEN}"},
        },
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="github",
        name="GitHub",
        category="Code",
        author="github",
        description="Read repos, issues, PRs; comment from notesci.",
        rating=4.8,
        installs="58k",
        official=True,
        transport="http",
        config={
            "url": "https://api.githubcopilot.com/mcp/",
            "headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"},
        },
        default_grants={
            "allowAll": False,
            "tools": ["search_repos", "read_repo", "read_file", "list_issues", "read_issue"],
            "deniedTools": ["create_issue", "create_pr", "merge_pr", "delete_repo"],
        },
    ),
    CatalogEntry(
        id="linear",
        name="Linear",
        category="Productivity",
        author="linear",
        description="Search and create issues; sync research tasks to your team.",
        rating=4.6,
        installs="22k",
        # Linear's hosted MCP is an SSE endpoint (the URL ends in
        # ``/sse``). The transport must be ``sse``, not ``http`` —
        # ``http`` routes it through the Streamable HTTP client, which
        # can't speak to an SSE server.
        transport="sse",
        config={
            "url": "https://mcp.linear.app/sse",
        },
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="notion",
        name="Notion",
        category="Writing",
        author="notion",
        description="Read pages, search workspaces, append blocks from chats.",
        rating=4.5,
        installs="35k",
        transport="http",
        config={
            "url": "https://mcp.notion.com/mcp",
            "headers": {"Authorization": "Bearer ${NOTION_TOKEN}"},
        },
        show_in_sources=True,
        source_fields=(
            CatalogField(
                label="Internal integration token",
                path="headers.Authorization",
                placeholder="Bearer secret_...",
                secret=True,
                help_url="https://www.notion.so/my-integrations",
            ),
        ),
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="slack",
        name="Slack",
        category="Productivity",
        author="slack",
        description="Search channels, post answers, share sessions.",
        rating=4.4,
        installs="40k",
        transport="stdio",
        config={
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-slack"],
            "env": {"SLACK_BOT_TOKEN": "", "SLACK_TEAM_ID": ""},
        },
        show_in_sources=False,
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="firecrawl",
        name="Firecrawl",
        category="Web",
        author="firecrawl",
        description="Crawl any site to clean Markdown for grounding.",
        rating=4.6,
        installs="18k",
        transport="stdio",
        config={
            "command": "npx",
            "args": ["-y", "firecrawl-mcp"],
            "env": {"FIRECRAWL_API_KEY": ""},
        },
        show_in_sources=False,
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="tavily",
        name="Tavily Web Search",
        category="Web",
        author="tavily",
        description="AI-friendly web search with structured snippets.",
        rating=4.7,
        installs="27k",
        transport="stdio",
        config={
            "command": "npx",
            "args": ["-y", "tavily-mcp"],
            "env": {"TAVILY_API_KEY": ""},
        },
        show_in_sources=False,
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="exa",
        name="Exa Academic Search",
        category="Research",
        author="exa",
        description="Neural web and academic search useful for related-work discovery, recent papers, and citation-safe literature exploration.",
        rating=4.6,
        installs="20k",
        official=True,
        transport="http",
        config={
            "url": "https://mcp.exa.ai/mcp",
        },
        show_in_sources=False,
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="zotero",
        name="Zotero",
        category="Research",
        author="54yyyu/zotero-mcp",
        description="Your local Zotero library — search, metadata, PDF full-text, annotations, semantic search. Talks to Zotero 7+ over the local API (no API key, no cloud round-trip).",
        rating=4.7,
        installs="14k",
        # Package is ``zotero-mcp-server`` (PyPI), console script is
        # ``zotero-mcp``. Default install runs in local mode against the
        # running Zotero 7+ instance via its built-in local API on
        # 127.0.0.1:23119 — no credentials needed. Users who want web
        # mode (cloud library) can set ZOTERO_API_KEY + ZOTERO_USER_ID
        # later from the Installed MCPs page.
        transport="stdio",
        config={
            "command": "uvx",
            "args": [
                "--from",
                "zotero-mcp-server",
                "zotero-mcp",
                "serve",
                "--transport",
                "stdio",
            ],
            "env": {"ZOTERO_LOCAL": "true"},
        },
        # Not a Sources connector — this is a regular MCP install. The
        # Sources page was a credentialed-connector surface; local-mode
        # Zotero needs zero config, so it belongs in the MCP catalog
        # alongside the rest.
        show_in_sources=False,
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="obsidian",
        name="Obsidian",
        category="Writing",
        author="MarkusPfundstein/mcp-obsidian",
        description="Read/search Obsidian notes through the Local REST API plugin.",
        rating=4.7,
        installs="21k",
        transport="stdio",
        config={
            "command": "uvx",
            "args": ["mcp-obsidian"],
            "env": {
                "OBSIDIAN_API_KEY": "",
                "OBSIDIAN_HOST": "127.0.0.1",
                "OBSIDIAN_PORT": "27124",
            },
        },
        show_in_sources=True,
        source_fields=(
            CatalogField(
                label="Local REST API key",
                path="env.OBSIDIAN_API_KEY",
                placeholder="Paste the key from Obsidian's Local REST API plugin",
                secret=True,
                help_url="https://github.com/coddingtonbear/obsidian-local-rest-api",
            ),
            CatalogField(
                label="Obsidian host",
                path="env.OBSIDIAN_HOST",
                placeholder="127.0.0.1",
            ),
            CatalogField(
                label="Obsidian port",
                path="env.OBSIDIAN_PORT",
                placeholder="27124",
            ),
        ),
        default_grants=_allow_all(),
    ),
    CatalogEntry(
        id="jupyter",
        name="Jupyter",
        category="Lab tools",
        author="jupyter",
        description="Run cells in a sandboxed kernel; read notebooks.",
        rating=4.5,
        installs="9k",
        # No widely-adopted MCP server for sandboxed Jupyter yet — keeping
        # it in the catalog as a "coming soon" hint of where notesci is going.
        available=False,
        transport="stdio",
        config={},
        default_grants=_allow_all(),
    ),
)


def _latest_user_mcps_mtime() -> float:
    """Return the newest mtime under ``~/.config/notesci/mcps``.

    This lets us refresh catalog merges when a user edits recipes
    during runtime, instead of requiring a restart.
    """
    try:
        from . import user_content as uc

        root = uc.MCPS_DIR
    except Exception:
        return 0.0

    if not root.exists():
        return 0.0

    newest = root.stat().st_mtime
    for path in Path(root).rglob("mcp.toml"):
        if path.is_file():
            try:
                newest = max(newest, path.stat().st_mtime)
            except OSError:
                continue
    return newest


_CATALOG_CACHE: dict[str, tuple[tuple[CatalogEntry, ...], float]] = {}


def _merged_catalog_cached() -> tuple[CatalogEntry, ...]:
    """Built-in CATALOG + user-installed recipes from ``~/.config/notesci/mcps/``.

    User recipes replace built-ins by ``id``. We reload when the user
    directory mtime changes so edits to local recipes are reflected
    without restarting the backend.
    """
    import logging

    log = logging.getLogger(__name__)
    marker = _latest_user_mcps_mtime()
    cached = _CATALOG_CACHE.get("merged")
    if cached is not None and cached[1] == marker:
        return cached[0]

    user: tuple[CatalogEntry, ...] = ()
    try:
        from . import user_content as uc
        from .user_mcps_loader import load_mcps_from_dir
        user = tuple(load_mcps_from_dir(uc.MCPS_DIR))
    except Exception:
        log.warning("user-MCP recipes load failed", exc_info=True)

    user_ids = {e.id for e in user}
    builtins = tuple(e for e in CATALOG if e.id not in user_ids)
    merged = (*user, *builtins)
    _CATALOG_CACHE["merged"] = (merged, marker)
    return merged


def list_catalog() -> tuple[CatalogEntry, ...]:
    return _merged_catalog_cached()


def get_entry(entry_id: str) -> CatalogEntry | None:
    for e in _merged_catalog_cached():
        if e.id == entry_id:
            return e
    return None
