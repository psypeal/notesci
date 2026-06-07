"""MCP host — catalog, install, and credential redaction.

Covers three slices the dashboard depends on:

  1. ``GET /mcp/catalog`` returns the curated marketplace entries —
     the dashboard's centerpiece is the catalog strip.
  2. Role gating — only owners/admins can ``POST /mcp/servers`` or
     ``PATCH``/``DELETE``. Members get 403 ``forbidden``.
  3. The redaction pass — secret-named keys in ``config.headers`` and
     the entire ``config.env`` map are replaced with ``"***"`` before
     the row leaves the API. This prevents the dashboard from leaking
     credentials back to a curious user.

The stdio-transport-restriction the prompt mentioned is **not yet
enforced** by the backend agent — every transport in the
``Literal["http", "stdio", "sse"]`` is currently accepted from an
admin. Marked with ``xfail`` so it goes green automatically when the
restriction lands.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.agent import mcp_tools as mcp_tools_module
from notesci.agent.mcp_tools import (
    _extract_zotero_collection_keys,
    _format_mcp_load_error,
    _harden_zotero_tools,
    _resolve_zotero_collection_key,
    _resolve_stdio_command,
    _stdio_env,
    _tool_arg_names,
    _wrap_zotero_collection_items_tool,
    _zotero_descendant_collections,
    _zotero_collection_items_empty,
    _zotero_collection_matches_for_name,
    _zotero_collection_search_matches_for_name,
)
from notesci.agent.graph import RequestCtx, _format_mcp_tool_status
from notesci.config import settings
from notesci.db import get_conn
from notesci.main import (
    app,
    _filter_mcp_tools_for_turn,
    _requested_mcp_slugs_for_turn,
)


@pytest.fixture
async def mcp_client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def _bootstrap_member(mcp_client: AsyncClient, *, admin: bool) -> dict:
    """Create a workspace + member; optionally promote to admin role."""
    admin_token = settings.notesci_admin_token or ""
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await mcp_client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin_token},
        json={"slug": slug, "name": f"MCP {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    code = r.json()["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await mcp_client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    member_id = body["member"]["id"]

    # The first claimer of a fresh workspace is auto-promoted to admin
    # (see /auth/claim). Force the role explicitly here so this helper
    # is deterministic regardless of claim order.
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE members SET role = %s WHERE id = %s",
            ("admin" if admin else "member", uuid.UUID(member_id)),
        )
        await conn.commit()

    return {
        "headers": {"Authorization": f"Bearer {body['token']}"},
        "member_id": member_id,
    }


# ---------------------------------------------------------------------------
# 1. Catalog
# ---------------------------------------------------------------------------


async def test_catalog_returns_curated_entries(mcp_client: AsyncClient):
    member = await _bootstrap_member(mcp_client, admin=False)
    r = await mcp_client.get("/mcp/catalog", headers=member["headers"])
    assert r.status_code == 200, r.text
    entries = r.json()
    # Catalog is server-curated and currently has ~14 entries
    # (see CLAUDE.md > "MCP host with curated catalog"). Don't pin the
    # exact count — pin the shape and that we got some.
    assert isinstance(entries, list)
    assert entries, "catalog should not be empty"
    sample = entries[0]
    for key in (
        "id", "name", "category", "author", "description",
        "transport", "config", "default_grants",
    ):
        assert key in sample, f"catalog entry missing {key!r}: {sample}"


async def test_catalog_requires_auth(mcp_client: AsyncClient):
    r = await mcp_client.get("/mcp/catalog")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# 2. Role gating
# ---------------------------------------------------------------------------


async def test_member_role_cannot_install_mcp_server(
    mcp_client: AsyncClient,
):
    """A claimed (role='member') user gets 403 on POST /mcp/servers."""
    member = await _bootstrap_member(mcp_client, admin=False)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": "blocked",
            "name": "Blocked",
            "transport": "http",
            "config": {"url": "https://example.test"},
            "grants": {},
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "forbidden"


async def test_admin_role_can_install_mcp_server(mcp_client: AsyncClient):
    """A promoted (role='admin') user can install an MCP server."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"srv-{uuid.uuid4().hex[:6]}",
            "name": "Admin-installed",
            "transport": "http",
            "config": {"url": "https://example.test"},
            "grants": {},
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["transport"] == "http"


async def test_admin_cannot_install_stdio_via_raw_endpoint(
    mcp_client: AsyncClient,
):
    """stdio MCP servers shell out a command, which is an RCE surface
    on the backend host. Raw stdio installs through POST /mcp/servers
    are refused; admins must go through the curated catalog install."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"stdio-{uuid.uuid4().hex[:6]}",
            "name": "stdio mcp",
            "transport": "stdio",
            "config": {"command": "/bin/echo", "args": ["pwned"]},
            "grants": {},
        },
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "stdio_not_allowed"


# ---------------------------------------------------------------------------
# 3. Credential redaction
# ---------------------------------------------------------------------------


async def test_mcp_server_response_redacts_secret_headers(
    mcp_client: AsyncClient,
):
    """The Authorization header value should be ``"***"`` on the API
    response, regardless of what the admin sent in."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"hdr-{uuid.uuid4().hex[:6]}",
            "name": "Headers test",
            "transport": "http",
            "config": {
                "url": "https://example.test",
                "headers": {
                    "Authorization": "Bearer real-secret-token",
                    "X-Api-Key": "real-api-key",
                    "User-Agent": "notesci",  # not secret — must survive
                },
            },
            "grants": {},
        },
    )
    assert r.status_code == 201, r.text
    headers_out = r.json()["config"]["headers"]
    assert headers_out["Authorization"] == "***"
    assert headers_out["X-Api-Key"] == "***"
    # Non-secret header passes through unchanged.
    assert headers_out["User-Agent"] == "notesci"


async def test_mcp_server_list_redacts_secret_env(mcp_client: AsyncClient):
    """For stdio servers (env-based credentials), the entire env map is
    redacted in the API response — every value becomes ``"***"``.

    Raw stdio installs are refused at the API layer (see the
    ``stdio_not_allowed`` test); the curated catalog is the only way
    in. We install ``firecrawl`` (a stdio entry with a
    ``FIRECRAWL_API_KEY`` env slot) and confirm the env values come
    back redacted."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/catalog/firecrawl/install",
        headers=member["headers"],
        json={},
    )
    assert r.status_code == 201, r.text
    env_out = r.json()["config"]["env"]
    # Catalog entry seeds ``FIRECRAWL_API_KEY: ""``; the redactor still
    # rewrites to ``"***"`` because *every* env value is treated as
    # secret.
    assert env_out == {"FIRECRAWL_API_KEY": "***"}


# ---------------------------------------------------------------------------
# 4. List / get also redact (defence in depth)
# ---------------------------------------------------------------------------


async def test_mcp_get_and_list_apply_redaction(mcp_client: AsyncClient):
    """The redactor must run on read paths too, not just on the
    install response — otherwise a refresh of the dashboard would leak."""
    member = await _bootstrap_member(mcp_client, admin=True)
    r = await mcp_client.post(
        "/mcp/servers",
        headers=member["headers"],
        json={
            "slug": f"both-{uuid.uuid4().hex[:6]}",
            "name": "Both",
            "transport": "http",
            "config": {
                "url": "https://example.test",
                "headers": {"Authorization": "Bearer x"},
            },
            "grants": {},
        },
    )
    assert r.status_code == 201, r.text
    sid = r.json()["id"]

    r = await mcp_client.get(
        f"/mcp/servers/{sid}", headers=member["headers"]
    )
    assert r.status_code == 200
    assert r.json()["config"]["headers"]["Authorization"] == "***"

    r = await mcp_client.get("/mcp/servers", headers=member["headers"])
    assert r.status_code == 200
    matched = [s for s in r.json() if s["id"] == sid]
    assert matched, "newly-installed server should be in the list"
    assert matched[0]["config"]["headers"]["Authorization"] == "***"


# ---------------------------------------------------------------------------
# 5. Zotero collection-name resolution
# ---------------------------------------------------------------------------


def test_zotero_collection_tree_match_exact_name():
    tree = """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
 - **Brain Aging Methods** (Key: EFGH5678)
"""
    assert _zotero_collection_matches_for_name(tree, "Brain Aging") == [
        ("Brain Aging", "ABCD1234")
    ]


def test_zotero_collection_tree_match_ambiguous_partial_name():
    tree = """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
- **Brain Aging Methods** (Key: EFGH5678)
"""
    assert _zotero_collection_matches_for_name(tree, "Brain") == [
        ("Brain Aging", "ABCD1234"),
        ("Brain Aging Methods", "EFGH5678"),
    ]


def test_zotero_collection_tree_match_plain_line_name():
    tree = """
# Zotero Collections

- Brain Aging (Key: ABCD1234)
- Other (Key: EFGH5678)
"""
    assert _zotero_collection_matches_for_name(tree, "Brain Aging") == [
        ("Brain Aging", "ABCD1234")
    ]


def test_zotero_collection_tree_match_nested_plain_line_name():
    tree = """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Brain Aging (Key: EFGH5678)
"""
    assert _zotero_collection_matches_for_name(tree, "Brain Aging") == [
        ("Brain Aging", "EFGH5678")
    ]


def test_zotero_collection_tree_finds_child_collection_items_fallback_keys():
    tree = """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Brain Aging (Key: EFGH5678)
  - Brain Imaging (Key: IJKL9012)
- Other (Key: MNOP3456)
"""
    assert _zotero_descendant_collections(tree, "ABCD1234") == [
        ("Brain Aging", "EFGH5678"),
        ("Brain Imaging", "IJKL9012"),
    ]


def test_zotero_collection_tree_match_duplicate_terminal_names():
    tree = """
# Zotero Collections

- Brain Aging (Key: ABCD1234)
- Parent (Key: IJKL9012)
  - Brain Aging (Key: EFGH5678)
"""
    assert _zotero_collection_matches_for_name(tree, "Brain Aging") == [
        ("Brain Aging", "ABCD1234"),
        ("Brain Aging", "EFGH5678"),
    ]


def test_zotero_collection_search_match_exact_name():
    search = """
# Collections matching 'Brain Aging'

## 1. Brain Aging

**Key:** `ABCD1234`

## 2. Brain Aging Methods

**Key:** `EFGH5678`
"""
    assert _zotero_collection_search_matches_for_name(search, "Brain Aging") == [
        ("Brain Aging", "ABCD1234")
    ]


def test_zotero_collection_search_match_ambiguous_partial_name():
    search = """
# Collections matching 'Brain'

## 1. Brain Aging
**Key:** `ABCD1234`

## 2. Brain Aging Methods
**Key:** `EFGH5678`
"""
    assert _zotero_collection_search_matches_for_name(search, "Brain") == [
        ("Brain Aging", "ABCD1234"),
        ("Brain Aging Methods", "EFGH5678"),
    ]


def test_zotero_collection_key_fallback_extracts_all_unique_keys():
    text = """
Possible matches:
- Brain Aging, Key: ABCD1234
- Brain Aging Methods, Key: EFGH5678
- Duplicate line, Key: ABCD1234
"""
    assert _extract_zotero_collection_keys(text) == ["ABCD1234", "EFGH5678"]


def test_mcp_tool_arg_names_supports_common_schema_shapes():
    class ArgsTool:
        args = {"collection_key": {}, "limit": {}}

    class V2Schema:
        model_fields = {"collection_key": object(), "detail": object()}

    class V2Tool:
        args_schema = V2Schema

    class V1Schema:
        __fields__ = {"collection_key": object(), "limit": object()}

    class V1Tool:
        args_schema = V1Schema

    assert _tool_arg_names(ArgsTool()) == {"collection_key", "limit"}
    assert _tool_arg_names(V2Tool()) == {"collection_key", "detail"}
    assert _tool_arg_names(V1Tool()) == {"collection_key", "limit"}


class _FakeMcpTool:
    def __init__(
        self,
        response: str,
        args: dict | None = None,
        name: str = "fake_tool",
    ):
        self.name = name
        self.description = ""
        self.return_direct = False
        self.response = response
        self.args = args or {}
        self.calls: list[dict] = []

    async def ainvoke(self, payload: dict):
        self.calls.append(payload)
        return self.response


async def test_zotero_resolver_accepts_exact_collection_key():
    search = _FakeMcpTool("unused")
    collections = _FakeMcpTool("unused")
    key, error = await _resolve_zotero_collection_key(
        "ABCD1234",
        search,
        collections,
    )
    assert key == "ABCD1234"
    assert error is None
    assert search.calls == []
    assert collections.calls == []


async def test_zotero_resolver_resolves_unique_collection_name_from_tree():
    collections = _FakeMcpTool(
        """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
- **Other** (Key: EFGH5678)
""",
        args={"limit": {}},
    )
    search = _FakeMcpTool("unused")
    key, error = await _resolve_zotero_collection_key(
        "Brain Aging",
        search,
        collections,
    )
    assert key == "ABCD1234"
    assert error is None
    assert collections.calls == [{"limit": 5000}]
    assert search.calls == []


async def test_zotero_resolver_rejects_ambiguous_collection_name():
    collections = _FakeMcpTool(
        """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
- **Brain Aging Methods** (Key: EFGH5678)
""",
        args={"limit": {}},
    )
    search = _FakeMcpTool("unused")
    key, error = await _resolve_zotero_collection_key(
        "Brain",
        search,
        collections,
    )
    assert key is None
    assert error is not None
    assert "Multiple Zotero collections match" in error
    assert "ABCD1234" in error
    assert "EFGH5678" in error
    assert search.calls == []


async def test_zotero_resolver_rejects_unstructured_multiple_key_fallback():
    search = _FakeMcpTool(
        """
Possible matches:
- Brain Aging, Key: ABCD1234
- Brain Aging Methods, Key: EFGH5678
"""
    )
    key, error = await _resolve_zotero_collection_key(
        "Brain",
        search,
        collections_tool=None,
    )
    assert key is None
    assert error is not None
    assert "Multiple Zotero collection keys" in error
    assert "ABCD1234" in error
    assert "EFGH5678" in error


async def test_zotero_collection_items_wrapper_accepts_collection_name_alias():
    upstream = _FakeMcpTool(
        "items",
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Brain Aging"})

    assert result == "items"
    assert collections.calls == [{"limit": 5000}]
    assert upstream.calls == [{"collection_key": "ABCD1234", "limit": 50}]


async def test_zotero_collection_items_wrapper_accepts_collection_alias():
    upstream = _FakeMcpTool(
        "items",
        args={"collection_key": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
""",
        name="zotero__zotero_get_collections",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection": "Brain Aging"})

    assert result == "items"
    assert collections.calls == [{}]
    assert upstream.calls == [{"collection_key": "ABCD1234"}]


async def test_zotero_collection_items_wrapper_accepts_query_alias():
    upstream = _FakeMcpTool(
        "items",
        args={"collection_key": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
""",
        name="zotero__zotero_get_collections",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"query": "Brain Aging"})

    assert result == "items"
    assert upstream.calls == [{"collection_key": "ABCD1234"}]


async def test_zotero_collection_items_wrapper_expands_empty_parent_collection():
    upstream = _FakeMcpTool(
        "No items found in collection: Parent (Key: ABCD1234)",
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Brain Aging (Key: EFGH5678)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        if payload["collection_key"] == "ABCD1234":
            return "No items found in collection: Parent (Key: ABCD1234)"
        return "# Items in Collection: Brain Aging\n\n## 1. Example paper"

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Parent"})

    assert "Items found in child collections" in result
    assert "Example paper" in result
    assert upstream.calls == [
        {"collection_key": "ABCD1234", "limit": 50},
        {"collection_key": "EFGH5678", "limit": 50},
    ]


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {},
        {"items": []},
        {"results": []},
        {"data": []},
        {"total": 0},
        "[]",
        "0 items",
        "0 items in collection: Parent",
        "No items in collection: Parent",
        ["No items found"],
        {"items": ["No items found"]},
        {"items": [{"type": "text", "text": "No items found"}]},
    ],
)
def test_zotero_collection_items_empty_accepts_structured_empty_shapes(payload):
    assert _zotero_collection_items_empty(payload)


def test_zotero_collection_items_empty_keeps_simple_item_lists_visible():
    assert not _zotero_collection_items_empty(["Example paper"])


async def test_zotero_collection_items_wrapper_formats_structured_items():
    upstream = _FakeMcpTool(
        {"items": [{"title": "Example paper", "year": 2024}]},
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=None,
    )

    result = await wrapped.ainvoke({"collection_key": "ABCD1234"})

    assert "## 1. Example paper" in result
    assert "- Metadata: 2024" in result
    assert '"items"' in result
    assert '"title": "Example paper"' in result
    assert '"year": 2024' in result


async def test_zotero_collection_items_wrapper_formats_simple_list_items():
    upstream = _FakeMcpTool(
        ["Example paper", "Second paper"],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=None,
    )

    result = await wrapped.ainvoke({"collection_key": "ABCD1234"})

    assert "## 1. Example paper" in result
    assert "## 2. Second paper" in result


async def test_zotero_collection_items_wrapper_truncates_large_raw_payloads():
    upstream = _FakeMcpTool(
        {"items": [{"title": "Large item", "abstractNote": "x" * 30000}]},
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=None,
    )

    result = await wrapped.ainvoke({"collection_key": "ABCD1234"})

    assert "## 1. Large item" in result
    assert "raw Zotero payload truncated by Notesci" in result


async def test_zotero_collection_items_wrapper_unwraps_text_blocks():
    upstream = _FakeMcpTool(
        [{"type": "text", "text": "# Items\n\n## 1. Example paper"}],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=None,
    )

    result = await wrapped.ainvoke({"collection_key": "ABCD1234"})

    assert result == "# Items\n\n## 1. Example paper"


async def test_zotero_collection_items_wrapper_expands_empty_text_block_parent():
    upstream = _FakeMcpTool(
        [{"type": "text", "text": "No items found in collection: Parent"}],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Brain Aging (Key: EFGH5678)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        if payload["collection_key"] == "ABCD1234":
            return [{"type": "text", "text": "No items found in collection: Parent"}]
        return [{"type": "text", "text": "# Items\n\n## 1. Example paper"}]

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Parent"})

    assert "Items found in child collections" in result
    assert "Example paper" in result
    assert upstream.calls == [
        {"collection_key": "ABCD1234", "limit": 50},
        {"collection_key": "EFGH5678", "limit": 50},
    ]


async def test_zotero_collection_items_wrapper_expands_structured_empty_parent_collection():
    upstream = _FakeMcpTool(
        [],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Brain Aging (Key: EFGH5678)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        if payload["collection_key"] == "ABCD1234":
            return []
        return {"items": [{"title": "Example paper"}]}

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Parent"})

    assert "Items found in child collections" in result
    assert "Example paper" in result
    assert upstream.calls == [
        {"collection_key": "ABCD1234", "limit": 50},
        {"collection_key": "EFGH5678", "limit": 50},
    ]


async def test_zotero_collection_items_wrapper_bounds_child_collection_scan():
    upstream = _FakeMcpTool(
        [],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Child One (Key: EFGH5678)
  - Child Two (Key: IJKL9012)
  - Child Three (Key: MNOP3456)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        if payload["collection_key"] == "ABCD1234":
            return []
        return {"items": [{"title": f"Paper from {payload['collection_key']}"}]}

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke(
        {"collection_name": "Parent", "max_child_collections": 1}
    )

    assert "Paper from EFGH5678" in result
    assert "Skipped 2 additional child collections" in result
    assert upstream.calls == [
        {"collection_key": "ABCD1234", "limit": 50},
        {"collection_key": "EFGH5678", "limit": 50},
    ]


async def test_zotero_collection_items_wrapper_lists_checked_children_when_no_items():
    upstream = _FakeMcpTool(
        [],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Parent (Key: ABCD1234)
  - Empty Child (Key: EFGH5678)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        return []

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Parent"})

    assert "Child collections checked" in result
    assert "Empty Child (Key: EFGH5678)" in result
    assert "Ask for a specific child collection key" in result


async def test_zotero_collection_items_wrapper_rejects_ambiguous_name_before_fetch():
    upstream = _FakeMcpTool(
        "items",
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- **Brain Aging** (Key: ABCD1234)
- **Brain Aging Methods** (Key: EFGH5678)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Brain"})

    assert "Multiple Zotero collections match" in result
    assert "ABCD1234" in result
    assert "EFGH5678" in result
    assert upstream.calls == []


async def test_zotero_collection_items_wrapper_rejects_missing_collection_ref():
    upstream = _FakeMcpTool(
        "items",
        args={"collection_key": {}},
        name="zotero__zotero_get_collection_items",
    )
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=None,
    )

    result = await wrapped.ainvoke({})

    assert "No collection name or key was provided" in result
    assert upstream.calls == []


async def test_zotero_collection_items_wrapper_accepts_key_aliases():
    for alias in ("key", "collection_id", "collectionId"):
        upstream = _FakeMcpTool(
            [{"title": "Alias routed paper", "key": "ITEM123"}],
            args={"collection_key": {}},
            name="zotero__zotero_get_collection_items",
        )
        wrapped = _wrap_zotero_collection_items_tool(
            upstream,
            search_tool=None,
            collections_tool=None,
        )

        result = await wrapped.ainvoke({alias: "ABCD1234"})

        assert "Alias routed paper" in result
        assert upstream.calls == [{"collection_key": "ABCD1234"}]


async def test_zotero_collection_items_wrapper_expands_box_drawing_tree():
    upstream = _FakeMcpTool(
        [],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

Parent (Key: ABCD1234)
│   ├── Brain Aging (Key: EFGH5678)
│   └── Methods (Key: IJKL9012)
Other (Key: MNOP3456)
""",
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        if payload["collection_key"] == "ABCD1234":
            return []
        if payload["collection_key"] == "EFGH5678":
            return {"items": [{"title": "Windows-visible Zotero item"}]}
        return []

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Parent"})

    assert "Windows-visible Zotero item" in result
    assert upstream.calls == [
        {"collection_key": "ABCD1234", "limit": 50},
        {"collection_key": "EFGH5678", "limit": 50},
        {"collection_key": "IJKL9012", "limit": 50},
    ]


async def test_zotero_collection_items_wrapper_expands_structured_collection_tree():
    upstream = _FakeMcpTool(
        [],
        args={"collection_key": {}, "limit": {}},
        name="zotero__zotero_get_collection_items",
    )
    collections = _FakeMcpTool(
        {
            "collections": [
                {
                    "name": "Parent",
                    "key": "ABCD1234",
                    "children": [
                        {"name": "Brain Aging", "key": "EFGH5678"},
                    ],
                }
            ]
        },
        args={"limit": {}},
        name="zotero__zotero_get_collections",
    )

    async def ainvoke(payload: dict):
        upstream.calls.append(payload)
        if payload["collection_key"] == "ABCD1234":
            return {"items": []}
        return {"items": [{"title": "Structured child collection item"}]}

    upstream.ainvoke = ainvoke
    wrapped = _wrap_zotero_collection_items_tool(
        upstream,
        search_tool=None,
        collections_tool=collections,
    )

    result = await wrapped.ainvoke({"collection_name": "Parent"})

    assert "Structured child collection item" in result
    assert upstream.calls == [
        {"collection_key": "ABCD1234", "limit": 50},
        {"collection_key": "EFGH5678", "limit": 50},
    ]


async def test_harden_zotero_tools_wraps_variant_collection_item_tool():
    upstream = _FakeMcpTool(
        [{"title": "Variant schema paper"}],
        args={"collection": {}, "limit": {}},
        name="zotero__get_collection_items",
    )
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Brain Aging (Key: ABCD1234)
""",
        args={"limit": {}},
        name="zotero__list_collections",
    )
    hardened = _harden_zotero_tools([upstream, collections])
    wrapped = next(tool for tool in hardened if tool.name == "zotero__get_collection_items")

    result = await wrapped.ainvoke({"collection_name": "Brain Aging"})

    assert "Variant schema paper" in result
    assert upstream.calls == [{"collection": "ABCD1234", "limit": 50}]


async def test_harden_zotero_tools_wraps_description_only_collection_item_tool():
    upstream = _FakeMcpTool(
        [{"title": "Description routed Zotero paper"}],
        args={"collection_id": {}, "limit": {}},
        name="zotero__get_items",
    )
    upstream.description = "Get items in a specific Zotero collection."
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Brain Aging (Key: ABCD1234)
""",
        args={"limit": {}},
        name="zotero__get_collections",
    )
    hardened = _harden_zotero_tools([upstream, collections])
    wrapped = next(tool for tool in hardened if tool.name == "zotero__get_items")

    result = await wrapped.ainvoke({"collection_name": "Brain Aging"})

    assert "Description routed Zotero paper" in result
    assert upstream.calls == [{"collection_id": "ABCD1234", "limit": 50}]


async def test_harden_zotero_tools_keeps_collection_listing_when_description_mentions_items():
    upstream = _FakeMcpTool(
        [{"title": "Listing tool still resolved paper"}],
        args={"collection_id": {}, "limit": {}},
        name="zotero__get_items",
    )
    upstream.description = "Get items in a specific Zotero collection."
    collections = _FakeMcpTool(
        """
# Zotero Collections

- Brain Aging (Key: ABCD1234)
""",
        args={"limit": {}},
        name="zotero__get_collections",
    )
    collections.description = "List collections so users can choose collection items."
    hardened = _harden_zotero_tools([upstream, collections])
    wrapped = next(tool for tool in hardened if tool.name == "zotero__get_items")

    result = await wrapped.ainvoke({"collection_name": "Brain Aging"})

    assert "Listing tool still resolved paper" in result
    assert collections.calls == [{"limit": 5000}]
    assert upstream.calls == [{"collection_id": "ABCD1234", "limit": 50}]


def test_collection_item_wording_loads_mcp_tools():
    assert _requested_mcp_slugs_for_turn(
        'what are the items in the collection "Animal use"?'
    ) == {"zotero"}


def test_research_mcp_aliases_load_targeted_servers():
    assert _requested_mcp_slugs_for_turn(
        "use scihub to fetch DOI 10.1000/example"
    ) == {"scihub"}
    assert _requested_mcp_slugs_for_turn(
        "use paper search for naphthalene toxicity"
    ) == {"paper-search"}
    assert _requested_mcp_slugs_for_turn(
        "search PubMed for PAH exposure"
    ) == {"pubmed"}
    assert _requested_mcp_slugs_for_turn(
        "use semantic scholar for brain aging"
    ) == {"semantic-scholar"}


def test_research_mcp_aliases_surface_load_errors():
    ctx = RequestCtx(
        tool_to_server_id={"pubmed__search": "srv-1"},
        mcp_load_errors={
            "paper-search": (
                "MCP package 'paper-search-mcp-nodejs' requires Node >=20; "
                "found Node v16.3.0 at C:\\Program Files\\nodejs\\node.exe."
            ),
        },
    )

    guidance = _format_mcp_tool_status(
        ctx,
        "use paper search for naphthalene toxicity",
    )

    assert guidance is not None
    assert "paper-search" in guidance
    assert "requires Node >=20" in guidance


def test_research_download_tools_are_kept_for_read_turns():
    class Tool:
        def __init__(self, name: str) -> None:
            self.name = name

    tools = [
        Tool("scihub__download_scihub_pdf"),
        Tool("scihub__search_scihub_by_doi"),
        Tool("scihub__delete_cache"),
    ]

    filtered, tool_to_server = _filter_mcp_tools_for_turn(
        tools,
        {
            "scihub__download_scihub_pdf": "srv-1",
            "scihub__search_scihub_by_doi": "srv-1",
            "scihub__delete_cache": "srv-1",
        },
        "use scihub to retrieve this DOI",
    )

    assert [tool.name for tool in filtered] == [
        "scihub__download_scihub_pdf",
        "scihub__search_scihub_by_doi",
    ]
    assert set(tool_to_server) == {
        "scihub__download_scihub_pdf",
        "scihub__search_scihub_by_doi",
    }


def test_research_mcp_load_errors_are_actionable():
    paper = _format_mcp_load_error("paper-search", RuntimeError("npm ETIMEDOUT"))
    scihub = _format_mcp_load_error("scihub", RuntimeError("uv download failed"))

    assert "managed Node 20" in paper
    assert "npm ETIMEDOUT" in paper
    assert "sci-hub-mcp-server" in scihub
    assert "uv download failed" in scihub


def test_windows_stdio_env_defaults_to_utf8_and_quiet_launchers(monkeypatch):
    monkeypatch.setattr(mcp_tools_module.sys, "platform", "win32")
    for key in (
        "PYTHONUTF8",
        "PYTHONIOENCODING",
        "UV_NO_PROGRESS",
        "NPM_CONFIG_UPDATE_NOTIFIER",
        "NPM_CONFIG_FUND",
        "NPM_CONFIG_AUDIT",
    ):
        monkeypatch.delenv(key, raising=False)

    env = _stdio_env({})

    assert env["PYTHONUTF8"] == "1"
    assert env["PYTHONIOENCODING"] == "utf-8"
    assert env["UV_NO_PROGRESS"] == "1"
    assert env["NPM_CONFIG_UPDATE_NOTIFIER"] == "false"
    assert env["NPM_CONFIG_FUND"] == "false"
    assert env["NPM_CONFIG_AUDIT"] == "false"


def test_paper_search_npx_uses_managed_node_when_system_node_is_too_old(monkeypatch):
    def fake_which(name: str, path: str | None = None) -> str | None:
        if name == "npx":
            return r"C:\Program Files\nodejs\npx.cmd"
        if name == "node":
            return r"C:\Program Files\nodejs\node.exe"
        return None

    class Result:
        returncode = 0
        stdout = "v16.3.0\n"
        stderr = ""

    monkeypatch.setattr(mcp_tools_module.shutil, "which", fake_which)
    monkeypatch.setattr(
        mcp_tools_module.subprocess,
        "run",
        lambda *args, **kwargs: Result(),
    )

    command, args = _resolve_stdio_command(
        "npx",
        ["-y", "paper-search-mcp-nodejs"],
        {"PATH": ""},
    )

    assert command.endswith("npx.cmd")
    assert args == [
        "-y",
        "--package",
        "node@20",
        "--package",
        "paper-search-mcp-nodejs",
        "paper-search-mcp-nodejs",
    ]


def test_paper_search_npx_keeps_args_when_node_is_new_enough(monkeypatch):
    def fake_which(name: str, path: str | None = None) -> str | None:
        if name == "npx":
            return r"C:\Program Files\nodejs\npx.cmd"
        if name == "node":
            return r"C:\Program Files\nodejs\node.exe"
        return None

    class Result:
        returncode = 0
        stdout = "v20.11.1\n"
        stderr = ""

    monkeypatch.setattr(mcp_tools_module.shutil, "which", fake_which)
    monkeypatch.setattr(
        mcp_tools_module.subprocess,
        "run",
        lambda *args, **kwargs: Result(),
    )

    command, args = _resolve_stdio_command(
        "npx",
        ["-y", "paper-search-mcp-nodejs"],
        {"PATH": ""},
    )

    assert command.endswith("npx.cmd")
    assert args == ["-y", "paper-search-mcp-nodejs"]


def test_scihub_legacy_git_uvx_config_rewrites_to_pypi(monkeypatch):
    monkeypatch.setattr(
        mcp_tools_module.shutil,
        "which",
        lambda name, path=None: r"C:\Users\me\.local\bin\uvx.exe"
        if name == "uvx"
        else None,
    )

    env = {"PATH": ""}
    command, args = _resolve_stdio_command(
        "uvx",
        [
            "--from",
            "git+https://github.com/riichard/Sci-Hub-MCP-Server",
            "sci-hub-mcp",
            "--transport",
            "stdio",
        ],
        env,
    )

    assert command.endswith("uvx.exe")
    assert args == ["--from", "sci-hub-mcp-server", "sci-hub-mcp-server"]
    assert env["PYTHONUTF8"] == "1"


def test_scihub_pypi_uvx_config_gets_windows_utf8_env(monkeypatch):
    monkeypatch.setattr(
        mcp_tools_module.shutil,
        "which",
        lambda name, path=None: r"C:\Users\me\.local\bin\uvx.exe"
        if name == "uvx"
        else None,
    )

    env = {"PATH": ""}
    command, args = _resolve_stdio_command(
        "uvx",
        ["--from", "sci-hub-mcp-server", "sci-hub-mcp-server"],
        env,
    )

    assert command.endswith("uvx.exe")
    assert args == ["--from", "sci-hub-mcp-server", "sci-hub-mcp-server"]
    assert env["PYTHONUTF8"] == "1"


def test_zotero_collection_item_guidance_prefers_direct_collection_name_call():
    ctx = RequestCtx(
        tool_to_server_id={
            "zotero__zotero_get_collections": "srv-1",
            "zotero__zotero_get_collection_items": "srv-1",
        }
    )

    guidance = _format_mcp_tool_status(
        ctx,
        'what are the items in the collection "Animal use"?',
    )

    assert guidance is not None
    assert "call zotero__zotero_get_collection_items directly" in guidance
    assert "collection_name" in guidance
    assert "Do not stop after listing collections" in guidance
    assert "resolve the 8-character collection key first" not in guidance


def test_zotero_collection_item_guidance_uses_tool_descriptions():
    tool = _FakeMcpTool("zotero__get_items")
    tool.description = "Get items in a specific Zotero collection."
    ctx = RequestCtx(
        tools=[tool],
        tool_to_server_id={
            "zotero__get_items": "srv-1",
        },
    )

    guidance = _format_mcp_tool_status(
        ctx,
        'what are the items in the collection "Animal use"?',
    )

    assert guidance is not None
    assert "call zotero__get_items directly" in guidance
    assert "collection_name" in guidance
