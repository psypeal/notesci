"""Compounding-knowledge loop tests.

Exercises the four caveats addressed in the chat → material filing
feature:

  1. **Dedup** — filing the same answer twice returns the existing
     material, never duplicates.
  2. **Connection strength** — strength is derived from the originating
     turn's ``message_citations`` (0 = weak, 1 = moderate, 2+ = strong).
  3. **Density cap** — a concept already linked to 8 materials in the
     project does not gain new weak links; moderate/strong filings
     evict an existing weak filing to make room.
  4. **Lineage** — each unique cited source from the originating turn
     gets a directed edge in ``material_lineage`` pointing at the new
     filed material.

The /materials/ingest path needs an embedder. We monkey-patch
``ingest.make_embedding_model`` to a fake so CI doesn't need an OpenAI
key — same trick as ``test_chat.py``.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from notesci.config import settings
from notesci.db import get_conn
from notesci.main import app


# ---------------------------------------------------------------------------
# Fake embedder — vectors are deterministic, no API key required.
# ---------------------------------------------------------------------------


class _FakeEmb:
    async def aembed_documents(self, texts):
        # 1536-dim zero vector matching the production
        # `vector(1536)` column type from migration 0002.
        return [[0.0] * 1536 for _ in texts]

    async def aembed_query(self, _q: str):
        return [0.0] * 1536


@pytest.fixture
def fake_embedder(monkeypatch: pytest.MonkeyPatch):
    from notesci import ingest as ingest_module
    from notesci import main as main_module

    monkeypatch.setattr(
        ingest_module, "make_embedding_model", lambda *a, **k: _FakeEmb()
    )
    # The ingest endpoints pre-flight-check that an embedding provider
    # is configured before doing any work. With a fake embedder there's
    # no real key, so we also stub the availability gate to True —
    # otherwise every /materials/ingest call here would 400 with
    # ``embedding_provider_unavailable``.
    monkeypatch.setattr(
        main_module, "embedding_provider_available", lambda *a, **k: True
    )


# ---------------------------------------------------------------------------
# Bootstrap helpers (reuse the workspace-boundary style)
# ---------------------------------------------------------------------------


async def _bootstrap_workspace(client: AsyncClient, admin_token: str) -> dict:
    slug = f"t{uuid.uuid4().hex[:10]}"
    r = await client.post(
        "/admin/workspaces",
        headers={"X-Admin-Token": admin_token},
        json={"slug": slug, "name": f"WS {slug}", "bootstrap_invites": 1},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _claim(client: AsyncClient, workspace: dict) -> dict:
    code = workspace["bootstrap_invites"][0]
    email = f"u-{uuid.uuid4().hex[:10]}@test.local"
    r = await client.post(
        "/auth/claim",
        json={"code": code, "email": email, "password": "x" * 12},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _create_project(client: AsyncClient, headers: dict) -> str:
    r = await client.post("/projects", headers=headers, json={"name": "P"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _seed_source_material(
    project_id: str, title: str, concept: str | None = None
) -> str:
    """Insert a real source material + (optionally) a concept row so the
    density-cap test has pre-existing concept neighbours to count."""
    mid = uuid.uuid4()
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO materials (id, project_id, source_type, title) "
            "VALUES (%s, %s, 'text', %s)",
            (mid, uuid.UUID(project_id), title),
        )
        if concept:
            await conn.execute(
                "INSERT INTO material_concepts (material_id, concept) "
                "VALUES (%s, %s)",
                (mid, concept),
            )
        await conn.commit()
    return str(mid)


async def _seed_session(project_id: str, member_id: str) -> str:
    """Mint a session row directly. The chat path normally creates one
    via /chat, but for filing-only tests we don't want to spin up an
    LLM stub for every test.

    Sessions are owned by their creator — the filing-provenance lookup
    binds to ``created_by_member_id``, so the test session must record
    the caller's id or the strength resolution silently degrades to weak.
    """
    sid = uuid.uuid4()
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO sessions (id, project_id, created_by_member_id) "
            "VALUES (%s, %s, %s)",
            (sid, uuid.UUID(project_id), uuid.UUID(member_id)),
        )
        await conn.commit()
    return str(sid)


async def _seed_citation(
    session_id: str,
    turn_seq: int,
    material_id: str,
    marker_n: int = 1,
) -> None:
    """Mint a message_citations row tying a turn to a cited material.
    We need a chunk_id too (FK NOT NULL) — pick the first chunk that
    belongs to the cited material, OR insert a stub chunk row."""
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT id FROM chunks WHERE material_id = %s LIMIT 1",
            (uuid.UUID(material_id),),
        )
        row = await cur.fetchone()
        if not row:
            # Insert a stub chunk for the cited material.
            await conn.execute(
                "INSERT INTO chunks (material_id, ord, text, embedding) "
                "VALUES (%s, 0, 'stub', %s::vector)",
                (uuid.UUID(material_id), "[" + ",".join(["0"] * 1536) + "]"),
            )
            cur = await conn.execute(
                "SELECT id FROM chunks WHERE material_id = %s LIMIT 1",
                (uuid.UUID(material_id),),
            )
            row = await cur.fetchone()
        chunk_id = row[0]
        await conn.execute(
            "INSERT INTO message_citations "
            "(session_id, turn_seq, marker_n, chunk_id, material_id) "
            "VALUES (%s, %s, %s, %s, %s)",
            (
                uuid.UUID(session_id),
                turn_seq,
                marker_n,
                chunk_id,
                uuid.UUID(material_id),
            ),
        )
        await conn.commit()


# ---------------------------------------------------------------------------
# Shared fixture: one workspace + member + project + session + 3 sources
# ---------------------------------------------------------------------------


@pytest.fixture
async def filing_env(fake_embedder):
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}
            project_id = await _create_project(client, hdr)
            session_id = await _seed_session(project_id, mem["member"]["id"])
            # Three real source materials we can cite in turn citations.
            sources = [
                await _seed_source_material(project_id, f"Source {i}")
                for i in range(3)
            ]
            yield {
                "client": client,
                "hdr": hdr,
                "project_id": project_id,
                "session_id": session_id,
                "sources": sources,
            }


# ---------------------------------------------------------------------------
# CAVEAT 1 — dedup by content hash
# ---------------------------------------------------------------------------


async def test_file_same_answer_twice_returns_existing(filing_env):
    env = filing_env
    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": "Filed PM2.5 answer",
        "text": "> Q: What links PM2.5 to dementia?\n\nUltrafine particles activate microglia.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 0,
    }
    r1 = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["already_filed"] is False
    first_id = body1["material_id"]

    r2 = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["already_filed"] is True
    assert body2["material_id"] == first_id  # same row, no new material

    # Whitespace-only differences also dedup (normalized hash).
    body_ws = dict(body)
    body_ws["text"] = body["text"] + "\n\n"
    r3 = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body_ws
    )
    assert r3.json()["already_filed"] is True
    assert r3.json()["material_id"] == first_id


# ---------------------------------------------------------------------------
# CAVEAT 2 — connection-strength rating
# ---------------------------------------------------------------------------


async def test_strength_weak_when_no_citations(filing_env):
    env = filing_env
    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": "Speculative",
        "text": "Speculative answer with no citations.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 0,
    }
    r = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r.status_code == 200, r.text
    assert r.json()["connection_strength"] == "weak"


async def test_strength_moderate_with_one_citation(filing_env):
    env = filing_env
    await _seed_citation(env["session_id"], 1, env["sources"][0])
    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": "Single-source answer",
        "text": "Backed by one source.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 1,
    }
    r = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r.json()["connection_strength"] == "moderate"


async def test_strength_strong_with_two_citations(filing_env):
    env = filing_env
    await _seed_citation(env["session_id"], 2, env["sources"][0], marker_n=1)
    await _seed_citation(env["session_id"], 2, env["sources"][1], marker_n=2)
    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": "Multi-source answer",
        "text": "Backed by two distinct sources.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 2,
    }
    r = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r.json()["connection_strength"] == "strong"


# ---------------------------------------------------------------------------
# CAVEAT 3 — concept density cap (8 materials per concept)
# ---------------------------------------------------------------------------


async def test_density_cap_drops_weak_filing(filing_env):
    """Pre-seed 8 real materials all carrying the same concept, then
    file a WEAK answer (no citations). The new material's concept link
    for the saturated concept must be dropped.

    Concept string must survive ``extract_concepts``: it captures
    Title-Case multi-word phrases and hyphenated terms like
    ``Amyloid-Beta`` but skips single lowercase words. We seed and
    ingest with the same capitalized form so the cap actually triggers.
    """
    env = filing_env
    concept = "Amyloid-Beta"
    for i in range(8):
        await _seed_source_material(
            env["project_id"], f"Pre-seeded {i}", concept=concept
        )

    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": f"Weak speculation about {concept}",
        "text": (
            f"Weak speculation: {concept} may have many roles. "
            f"Further {concept} research is needed."
        ),
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 5,
    }
    r = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r.status_code == 200, r.text
    assert r.json()["connection_strength"] == "weak"
    new_id = r.json()["material_id"]

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM material_concepts WHERE material_id = %s AND concept = %s",
            (uuid.UUID(new_id), concept),
        )
        row = await cur.fetchone()
    assert row is None, (
        f"weak filing should not gain a link to a saturated concept {concept!r}"
    )


async def test_density_cap_strong_evicts_weak_filing(filing_env):
    """Pre-seed 7 real materials + 1 weak filing all carrying the same
    concept. A new STRONG filing should evict the weak filing's link
    to free a slot."""
    env = filing_env
    concept = "Long-Term Potentiation"
    for i in range(7):
        await _seed_source_material(
            env["project_id"], f"Real source {i}", concept=concept
        )

    # First file a weak filing for the concept (no citations on turn 10).
    weak_body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": f"Weak filing about {concept}",
        "text": f"Weak: {concept} possibly relates to {concept} dynamics.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 10,
    }
    r1 = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=weak_body
    )
    weak_id = r1.json()["material_id"]
    assert r1.json()["connection_strength"] == "weak"
    # Confirm the weak filing got the concept link (cap was 8 but
    # not breached yet — 7 real + this weak = 8 exactly).
    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM material_concepts WHERE material_id = %s AND concept = %s",
            (uuid.UUID(weak_id), concept),
        )
        assert (await cur.fetchone()) is not None

    # Now file a STRONG filing — 2 citations seeded on turn 11.
    await _seed_citation(env["session_id"], 11, env["sources"][0], marker_n=1)
    await _seed_citation(env["session_id"], 11, env["sources"][1], marker_n=2)
    strong_body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": f"Strong filing about {concept}",
        "text": f"Strong: {concept} is well-established in {concept} literature.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 11,
    }
    r2 = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=strong_body
    )
    strong_id = r2.json()["material_id"]
    assert r2.json()["connection_strength"] == "strong"

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM material_concepts WHERE material_id = %s AND concept = %s",
            (uuid.UUID(strong_id), concept),
        )
        assert (await cur.fetchone()) is not None, "strong filing must keep its concept link"
        cur = await conn.execute(
            "SELECT 1 FROM material_concepts WHERE material_id = %s AND concept = %s",
            (uuid.UUID(weak_id), concept),
        )
        assert (await cur.fetchone()) is None, "weak filing should be evicted to make room"


# ---------------------------------------------------------------------------
# CAVEAT 4 — lineage edges
# ---------------------------------------------------------------------------


async def test_lineage_edges_created_from_cited_sources(filing_env):
    env = filing_env
    await _seed_citation(env["session_id"], 20, env["sources"][0], marker_n=1)
    await _seed_citation(env["session_id"], 20, env["sources"][1], marker_n=2)
    # The same source cited twice (e.g. multiple chunks) must collapse
    # to a single lineage edge, not duplicate.
    await _seed_citation(env["session_id"], 20, env["sources"][1], marker_n=3)

    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": "Lineage test",
        "text": "Lineage test body — derives from two distinct sources.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 20,
    }
    r = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r.status_code == 200, r.text
    new_id = uuid.UUID(r.json()["material_id"])

    async with get_conn() as conn:
        cur = await conn.execute(
            "SELECT source_id::text, session_id::text, turn_seq "
            "FROM material_lineage WHERE filed_id = %s "
            "ORDER BY source_id",
            (new_id,),
        )
        rows = await cur.fetchall()

    assert len(rows) == 2, f"expected 2 unique lineage edges, got {rows}"
    source_ids = {r[0] for r in rows}
    assert source_ids == {env["sources"][0], env["sources"][1]}
    for _, sid, ts in rows:
        assert sid == env["session_id"]
        assert ts == 20


# ---------------------------------------------------------------------------
# CAVEAT 2 bonus — Map view quarantines weak filings
# ---------------------------------------------------------------------------


async def test_map_view_hides_weak_by_default(filing_env):
    env = filing_env
    body = {
        "project_id": env["project_id"],
        "source_type": "text",
        "title": "Unique-weak-filing-title-xyz",
        "text": "Weak filing unique body for map test.",
        "filed_from_session_id": env["session_id"],
        "filed_from_turn_seq": 30,
    }
    r = await env["client"].post(
        "/materials/ingest", headers=env["hdr"], json=body
    )
    assert r.json()["connection_strength"] == "weak"

    # Default: weak hidden.
    r_default = await env["client"].get(
        f"/projects/{env['project_id']}/map", headers=env["hdr"]
    )
    assert r_default.status_code == 200
    labels = {n["label"] for n in r_default.json()["nodes"]}
    assert body["title"] not in labels

    # Explicit include_weak=true: surfaced.
    r_with = await env["client"].get(
        f"/projects/{env['project_id']}/map?include_weak=true",
        headers=env["hdr"],
    )
    labels = {n["label"] for n in r_with.json()["nodes"]}
    assert body["title"] in labels


# ---------------------------------------------------------------------------
# CAVEAT 1 bonus — dedup is project-scoped, not global
# ---------------------------------------------------------------------------


async def test_dedup_is_project_scoped(fake_embedder):
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admin = settings.notesci_admin_token or ""
            ws = await _bootstrap_workspace(client, admin)
            mem = await _claim(client, ws)
            hdr = {"Authorization": f"Bearer {mem['token']}"}
            p1 = await _create_project(client, hdr)
            p2 = await _create_project(client, hdr)
            sid1 = await _seed_session(p1, mem["member"]["id"])
            sid2 = await _seed_session(p2, mem["member"]["id"])
            shared_text = "Identical body in two projects."

            r1 = await client.post(
                "/materials/ingest",
                headers=hdr,
                json={
                    "project_id": p1, "source_type": "text",
                    "title": "Shared", "text": shared_text,
                    "filed_from_session_id": sid1, "filed_from_turn_seq": 0,
                },
            )
            assert r1.json()["already_filed"] is False
            r2 = await client.post(
                "/materials/ingest",
                headers=hdr,
                json={
                    "project_id": p2, "source_type": "text",
                    "title": "Shared", "text": shared_text,
                    "filed_from_session_id": sid2, "filed_from_turn_seq": 0,
                },
            )
            # Different project → no dedup → new material.
            assert r2.json()["already_filed"] is False
            assert r2.json()["material_id"] != r1.json()["material_id"]
