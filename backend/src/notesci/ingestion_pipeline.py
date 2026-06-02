"""Post-ingest pipeline: rename → extract metadata → surface concepts →
build wiki links.

The endpoint (:func:`main.materials_ingest_pdf` /
:func:`main.materials_ingest_url`) is responsible for the *fast* path —
chunk + embed + persist — so users see the material appear immediately.
Once that's done it dispatches :func:`run_pipeline` as a background
task. Each stage updates the ``ingestion_jobs`` row so the frontend can
poll for a progress chip and an animation.

Layout mirrors the knowledge-vault plugin:

* ``backend.scripts.ingestion.derive_slug``      – bibliographic slug
* ``backend.scripts.ingestion.extract_metadata`` – PDF first-page parse
* ``backend.scripts.ingestion.build_wiki_links`` – concept-overlap edges

Each step is wrapped in a ``try/except`` that records the failure on
the job row without poisoning the surrounding chunks/embeddings — a
partial pipeline still leaves the material searchable.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import Counter
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from .agent.providers import make_chat_model
from .concepts import extract_concepts
from .db import get_conn

from .ingestion.build_wiki_links import build_links
from .ingestion.derive_slug import derive_slug
from .ingestion.extract_metadata import extract_metadata

log = logging.getLogger(__name__)


# Order matters — the UI animation steps in this sequence.
STAGES = (
    "uploaded",
    "extracting_metadata",
    "renaming",
    "chunking",
    "embedding",
    "extracting_concepts",
    "building_links",
    "building_tree",
    "ready",
)


async def create_job(
    conn, *, material_id: UUID, project_id: UUID, stage: str = "uploaded"
) -> UUID:
    """Create the ingestion_jobs row that the rest of the pipeline updates."""
    row = await (
        await conn.execute(
            """
            INSERT INTO ingestion_jobs (material_id, project_id, stage, progress)
            VALUES (%s, %s, %s, %s) RETURNING id
            """,
            (material_id, project_id, stage, _stage_progress(stage)),
        )
    ).fetchone()
    await conn.commit()
    return row[0]


def _stage_progress(stage: str) -> float:
    """Normalised 0–1 progress per stage (for the UI bar)."""
    try:
        idx = STAGES.index(stage)
    except ValueError:
        return 0.0
    return round(idx / (len(STAGES) - 1), 3)


async def _set_stage(
    conn,
    *,
    job_id: UUID,
    stage: str,
    note: str | None = None,
) -> None:
    await conn.execute(
        """
        UPDATE ingestion_jobs
           SET stage = %s,
               progress = %s,
               note = COALESCE(%s, note),
               updated_at = now()
         WHERE id = %s
        """,
        (stage, _stage_progress(stage), note, job_id),
    )
    await conn.commit()


async def _fail(
    conn, *, job_id: UUID, code: str, message: str
) -> None:
    await conn.execute(
        """
        UPDATE ingestion_jobs
           SET stage = 'failed',
               error_code = %s,
               error_msg = %s,
               updated_at = now()
         WHERE id = %s
        """,
        (code, message[:500], job_id),
    )
    await conn.commit()


async def _existing_slugs(conn, project_id: UUID) -> set[str]:
    """Collect existing material slugs in the project so a freshly-derived
    slug can be disambiguated against them.
    """
    cur = await conn.execute(
        """
        SELECT (metadata ->> 'slug') AS slug
          FROM materials
         WHERE project_id = %s
           AND metadata ->> 'slug' IS NOT NULL
        """,
        (project_id,),
    )
    return {r[0] for r in await cur.fetchall() if r[0]}


async def _llm_refine_slug(
    *,
    first_lines: str,
    deterministic: dict[str, Any],
    model: str | None,
) -> dict[str, Any] | None:
    """LLM monitor pass — refines ``entity / year / keyword`` when the
    regex heuristics returned ambiguous results.

    Best-effort: failures fall back to the deterministic guess. The
    chokepoint stays ``make_chat_model`` per the project rules.
    """
    try:
        llm = make_chat_model(model)
    except Exception:
        return None

    prompt = (
        "You are renaming a research artifact. Given the first lines of a "
        "PDF, return JSON {\"entity\": ..., \"year\": ..., \"keyword\": ...} "
        "where:\n"
        " - entity = first-author surname (papers) or org abbreviation (reports)\n"
        " - year   = 4-digit publication year if visible, otherwise empty\n"
        " - keyword = 1-2 word topical hook from the title (lowercase)\n"
        "If a field cannot be determined, return an empty string for it. "
        "Return JSON only — no prose, no markdown fences.\n\n"
        f"Current guess: {json.dumps(deterministic)}\n"
        f"First lines:\n{first_lines}\n"
    )
    try:
        msg = await llm.ainvoke(prompt)
    except Exception as e:
        log.info("slug refine: LLM call failed: %s", e)
        return None
    text = getattr(msg, "content", "") or ""
    if isinstance(text, list):
        text = "".join(
            seg.get("text", "") if isinstance(seg, dict) else str(seg)
            for seg in text
        )
    text = text.strip()
    # Strip markdown fences just in case the model ignored the
    # instruction and wrapped JSON in ```json … ```.
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()
    try:
        data = json.loads(text)
    except Exception:
        log.info("slug refine: LLM output not parseable: %r", text[:200])
        return None
    if not isinstance(data, dict):
        return None
    return data


async def _stage_extract_metadata(
    conn,
    *,
    job_id: UUID,
    material_id: UUID,
    text_head: str,
    original_filename: str | None,
    model: str | None,
) -> dict[str, Any]:
    await _set_stage(conn, job_id=job_id, stage="extracting_metadata")
    md = extract_metadata(text_head)
    deterministic = {
        "entity": md.entity or "",
        "year": md.year or "",
        "keyword": md.keyword or "",
        "title": md.title or "",
    }
    note = "ok"
    # Only call the LLM if the cheap heuristic left something obviously
    # missing — saves a round-trip on the happy path.
    if not deterministic["entity"] or not deterministic["keyword"]:
        refined = await _llm_refine_slug(
            first_lines=md.raw_first_lines or "",
            deterministic=deterministic,
            model=model,
        )
        if refined:
            for k in ("entity", "year", "keyword", "title"):
                v = refined.get(k)
                if isinstance(v, str) and v.strip():
                    deterministic[k] = v.strip()
            note = "llm-refined"

    # Persist what we learned to the material's metadata JSON.
    # `original_filename` is ``str | None``; Postgres can't infer the
    # parameter type of a bare NULL passed to `jsonb_build_object`
    # (function returns `any`, so neither end of the binding pins down
    # the type), and psycopg surfaces that as "could not determine data
    # type of parameter $2". Cast explicitly so a missing filename
    # serializes to JSON null instead of crashing the whole stage —
    # which would also block downstream wiki-link / concept extraction.
    await conn.execute(
        """
        UPDATE materials
           SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object(
                                 'extracted', %s::jsonb,
                                 'original_filename', %s::text
                             )
         WHERE id = %s
        """,
        (Jsonb(deterministic), original_filename, material_id),
    )
    await conn.commit()
    await _set_stage(
        conn,
        job_id=job_id,
        stage="extracting_metadata",
        note=f"entity={deterministic.get('entity') or '∅'}; year={deterministic.get('year') or '∅'}; via={note}",
    )
    return deterministic


async def _stage_rename(
    conn,
    *,
    job_id: UUID,
    material_id: UUID,
    project_id: UUID,
    extracted: dict[str, Any],
    fallback_title: str | None,
) -> str | None:
    """Apply the derived slug + a clean title to the material row."""
    await _set_stage(conn, job_id=job_id, stage="renaming")
    existing = await _existing_slugs(conn, project_id)
    slug = derive_slug(
        extracted.get("entity") or "",
        extracted.get("year") or "",
        extracted.get("keyword") or "",
        existing=existing,
    )
    if slug == "untitled" and fallback_title:
        slug = derive_slug("", "", fallback_title, existing=existing)
    if slug == "untitled":
        # Nothing salvageable — leave the material's title alone.
        return None

    # Prefer an extracted title; otherwise rebuild one from the slug.
    title = (
        extracted.get("title")
        or fallback_title
        or slug.replace("-", " ").title()
    )
    title = title.strip()[:240]

    # `jsonb_build_object` accepts `any` for its value args, so postgres
    # can't infer the parameter type at parse / prepared-statement time.
    # Cast %s::text so the prepared-statement path doesn't fail with
    # "could not determine data type of parameter" — same root cause as
    # the extract_metadata stage above.
    await conn.execute(
        """
        UPDATE materials
           SET title = %s,
               metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('slug', %s::text)
         WHERE id = %s
        """,
        (title, slug, material_id),
    )
    await conn.commit()
    await _set_stage(conn, job_id=job_id, stage="renaming", note=f"slug={slug}")
    return slug


async def _stage_concepts(
    conn,
    *,
    job_id: UUID,
    material_id: UUID,
    full_text: str,
) -> list[str]:
    await _set_stage(conn, job_id=job_id, stage="extracting_concepts")
    raw = extract_concepts(full_text or "")
    if not raw:
        await _set_stage(
            conn, job_id=job_id, stage="extracting_concepts", note="0 concepts"
        )
        return []

    # Count occurrences across the body so we can keep the strongest
    # concepts for the wiki-link pass. Lowercased keys keep the join in
    # build_wiki_links case-insensitive.
    body_lower = full_text.lower() if full_text else ""
    counter: Counter[str] = Counter()
    for c in raw:
        if not c.strip():
            continue
        # Cheap occurrence proxy: count whitespace-delimited hits.
        count = body_lower.count(c.lower()) if body_lower else 1
        counter[c] = max(count, 1)

    # Cap to top N — long full-text papers can otherwise pump hundreds
    # of low-value matches into the join.
    top = counter.most_common(80)

    async with conn.cursor() as cur:
        # Wipe stale rows so re-ingesting refreshes the set.
        await cur.execute(
            "DELETE FROM material_concepts WHERE material_id = %s", (material_id,)
        )
        await cur.executemany(
            """
            INSERT INTO material_concepts (material_id, concept, count)
            VALUES (%s, %s, %s)
            ON CONFLICT (material_id, concept) DO UPDATE SET count = EXCLUDED.count
            """,
            [(material_id, concept, count) for concept, count in top],
        )
    await conn.commit()
    await _set_stage(
        conn,
        job_id=job_id,
        stage="extracting_concepts",
        note=f"{len(top)} concepts",
    )
    return [c for c, _ in top]


async def _stage_wiki_links(
    conn,
    *,
    job_id: UUID,
    project_id: UUID,
    target_id: UUID,
) -> int:
    await _set_stage(conn, job_id=job_id, stage="building_links")
    cur = await conn.execute(
        """
        SELECT m.id::text, mc.concept
          FROM material_concepts mc
          JOIN materials m ON m.id = mc.material_id
         WHERE m.project_id = %s
        """,
        (project_id,),
    )
    rows = await cur.fetchall()
    per_mat: dict[str, list[str]] = {}
    for mid, concept in rows:
        per_mat.setdefault(mid, []).append(concept)

    links = build_links(per_mat)
    target_str = str(target_id)
    # Only refresh edges touching the *new* material so older edges in
    # the project stay stable (cheap incremental update).
    touching = [link for link in links if target_str in (link.a_id, link.b_id)]

    async with conn.cursor() as cur:
        await cur.execute(
            """
            DELETE FROM material_links
             WHERE project_id = %s
               AND (a_id = %s OR b_id = %s)
            """,
            (project_id, target_id, target_id),
        )
        await cur.executemany(
            """
            INSERT INTO material_links (a_id, b_id, project_id, weight, shared, kind)
            VALUES (%s, %s, %s, %s, %s, 'concept')
            ON CONFLICT (a_id, b_id) DO UPDATE SET weight = EXCLUDED.weight,
                                                   shared = EXCLUDED.shared
            """,
            [
                (
                    UUID(link.a_id),
                    UUID(link.b_id),
                    project_id,
                    link.weight,
                    Jsonb(list(link.shared)),
                )
                for link in touching
            ],
        )
    await conn.commit()
    await _set_stage(
        conn,
        job_id=job_id,
        stage="building_links",
        note=f"{len(touching)} links",
    )
    return len(touching)


async def _stage_tree(
    conn,
    *,
    job_id: UUID,
    material_id: UUID,
    project_id: UUID,
    model: str | None,
) -> None:
    """Optional PageIndex tree-build stage.

    Only PDFs (rows with ``original_bytes IS NOT NULL`` and an
    ``application/pdf`` mime) qualify. Best-effort: a failed build
    inserts a ``material_trees`` row with status='failed' rather than
    poisoning the surrounding pipeline — the material stays searchable
    via vector retrieval. Gated by ``settings.notesci_pagetree_enabled``;
    when off, this stage is a no-op.
    """
    # Local import so the dev env doesn't pay for the vendor on every
    # import of this module.
    from .pagetree import build_tree, is_enabled
    from .config import settings
    from .agent.providers import resolve_default_model

    tree_model = model or settings.notesci_pagetree_model or resolve_default_model()

    await _set_stage(conn, job_id=job_id, stage="building_tree")
    if not is_enabled():
        await _set_stage(
            conn, job_id=job_id, stage="building_tree", note="disabled"
        )
        return

    cur = await conn.execute(
        "SELECT original_bytes, original_mime FROM materials WHERE id = %s",
        (material_id,),
    )
    row = await cur.fetchone()
    if not row or not row[0] or (row[1] or "") != "application/pdf":
        await _set_stage(
            conn, job_id=job_id, stage="building_tree", note="not-a-pdf"
        )
        return

    pdf_bytes = bytes(row[0])
    # Mark pending so a poller (or a parallel chat call) knows a build
    # is in flight.
    await conn.execute(
        """
        INSERT INTO material_trees (material_id, project_id, status, model)
        VALUES (%s, %s, 'pending', %s)
        ON CONFLICT (material_id) DO UPDATE
          SET status = 'pending',
              error = NULL,
              model = EXCLUDED.model,
              updated_at = now()
        """,
        (material_id, project_id, tree_model),
    )
    await conn.commit()

    try:
        tree = await build_tree(
            pdf_bytes,
            model=tree_model,
            max_pages=settings.notesci_pagetree_max_pages,
        )
    except Exception as e:
        log.exception("pagetree build raised for material %s", material_id)
        await conn.execute(
            """
            UPDATE material_trees
               SET status = 'failed',
                   error = %s,
                   updated_at = now()
             WHERE material_id = %s
            """,
            (str(e)[:500], material_id),
        )
        await conn.commit()
        await _set_stage(
            conn, job_id=job_id, stage="building_tree", note="failed"
        )
        return

    if tree is None:
        # Skipped — either too large or unparseable. Leave the row as
        # 'skipped' so we don't keep retrying on every re-index.
        await conn.execute(
            """
            UPDATE material_trees
               SET status = 'skipped',
                   updated_at = now()
             WHERE material_id = %s
            """,
            (material_id,),
        )
        await conn.commit()
        await _set_stage(
            conn, job_id=job_id, stage="building_tree", note="skipped"
        )
        return

    # Count nodes for the audit/admin view.
    def _node_count(node: Any) -> int:
        if isinstance(node, dict):
            n = 1 if node.get("node_id") else 0
            return n + _node_count(node.get("nodes") or [])
        if isinstance(node, list):
            return sum(_node_count(child) for child in node)
        return 0

    structure = tree.get("structure") or []
    n_nodes = _node_count(structure)

    await conn.execute(
        """
        UPDATE material_trees
           SET status = 'ready',
               tree = %s,
               node_count = %s,
               page_count = %s,
               updated_at = now()
         WHERE material_id = %s
        """,
        (Jsonb(tree), n_nodes, tree.get("page_count"), material_id),
    )
    await conn.commit()
    await _set_stage(
        conn, job_id=job_id, stage="building_tree", note=f"{n_nodes} nodes"
    )


async def run_pipeline(
    *,
    job_id: UUID,
    material_id: UUID,
    project_id: UUID,
    full_text: str,
    original_filename: str | None,
    fallback_title: str | None,
    model: str | None,
) -> None:
    """End-to-end orchestrator. Designed to be launched via
    ``asyncio.create_task`` from the upload endpoint so the HTTP
    response returns immediately.

    Errors are swallowed onto the job row — the user still gets the
    material; only the metadata + links pieces are skipped.
    """
    try:
        async with get_conn() as conn:
            text_head = full_text[:4000] if full_text else ""
            extracted = await _stage_extract_metadata(
                conn,
                job_id=job_id,
                material_id=material_id,
                text_head=text_head,
                original_filename=original_filename,
                model=model,
            )
            await _stage_rename(
                conn,
                job_id=job_id,
                material_id=material_id,
                project_id=project_id,
                extracted=extracted,
                fallback_title=fallback_title,
            )
            # chunking + embedding already happened synchronously in
            # the endpoint — just mark the stages so the UI animation
            # walks through them.
            await _set_stage(conn, job_id=job_id, stage="chunking", note="precomputed")
            await _set_stage(conn, job_id=job_id, stage="embedding", note="precomputed")
            await _stage_concepts(
                conn,
                job_id=job_id,
                material_id=material_id,
                full_text=full_text,
            )
            await _stage_wiki_links(
                conn,
                job_id=job_id,
                project_id=project_id,
                target_id=material_id,
            )
            await _stage_tree(
                conn,
                job_id=job_id,
                material_id=material_id,
                project_id=project_id,
                model=model,
            )
            await _set_stage(conn, job_id=job_id, stage="ready")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log.exception("ingestion pipeline failed for material %s", material_id)
        try:
            async with get_conn() as conn:
                await _fail(
                    conn,
                    job_id=job_id,
                    code="pipeline_error",
                    message=str(e),
                )
        except Exception:
            # Logging is best-effort — the user already has the material.
            log.exception("failed to record pipeline failure")
