"""Build concept-overlap links between materials — port of the
knowledge-vault plugin's ``enrich-references.sh`` pattern.

A "wiki link" between two materials means they share enough concepts
that the workspace's Concepts graph should connect them. The weight is
``|concepts(a) ∩ concepts(b)| / sqrt(|concepts(a)| * |concepts(b)|)``
(cosine over a one-hot concept vector) which keeps it scale-invariant —
short notes don't dominate longer papers, and the top-K pruning falls
out naturally.

Usable both from :func:`notesci.ingestion_pipeline.run_pipeline` (every
fresh upload re-builds its row of links) and from the CLI for
back-filling.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class WikiLink:
    a_id: str
    b_id: str
    weight: float
    shared: tuple[str, ...]


def build_links(
    concepts_per_material: dict[str, Iterable[str]],
    *,
    min_overlap: int = 2,
    min_weight: float = 0.08,
    top_k: int | None = 8,
) -> list[WikiLink]:
    """For each pair of materials, compute weighted overlap and return
    the strongest edges.

    - ``min_overlap``: drop pairs that share fewer than N concepts
      (random one-off overlap is usually noise).
    - ``min_weight``: drop pairs below this cosine score.
    - ``top_k``: keep only the K highest-weight neighbours per material
      (otherwise dense graphs explode).

    Output rows are *canonical*: ``a_id < b_id`` so the caller can use
    a primary-key insert without dedup.
    """
    sets: dict[str, frozenset[str]] = {
        mid: frozenset(c.lower() for c in concepts) for mid, concepts in concepts_per_material.items()
    }
    ids = sorted(sets)
    pair_scores: dict[tuple[str, str], tuple[float, tuple[str, ...]]] = {}
    for i, a_id in enumerate(ids):
        a_set = sets[a_id]
        if not a_set:
            continue
        for b_id in ids[i + 1 :]:
            b_set = sets[b_id]
            if not b_set:
                continue
            shared = a_set & b_set
            if len(shared) < min_overlap:
                continue
            weight = len(shared) / math.sqrt(len(a_set) * len(b_set))
            if weight < min_weight:
                continue
            pair_scores[(a_id, b_id)] = (weight, tuple(sorted(shared)))

    # Per-material top_k pruning, then merge back into a unique set.
    if top_k is not None and top_k > 0:
        neighbours: dict[str, list[tuple[float, str, tuple[str, ...]]]] = {
            mid: [] for mid in ids
        }
        for (a, b), (w, sh) in pair_scores.items():
            neighbours[a].append((w, b, sh))
            neighbours[b].append((w, a, sh))
        keep: set[tuple[str, str]] = set()
        for mid, edges in neighbours.items():
            edges.sort(reverse=True)
            for w, other, _sh in edges[:top_k]:
                pair = (mid, other) if mid < other else (other, mid)
                keep.add(pair)
        pair_scores = {p: pair_scores[p] for p in pair_scores if p in keep}

    return [
        WikiLink(a_id=a, b_id=b, weight=round(w, 4), shared=sh)
        for (a, b), (w, sh) in sorted(
            pair_scores.items(), key=lambda kv: kv[1][0], reverse=True
        )
    ]


def _cli() -> int:
    ap = argparse.ArgumentParser(
        description="Build concept-overlap wiki links from a JSON map of material_id → concepts.",
    )
    ap.add_argument(
        "path",
        help="JSON file: {material_id: [concept, ...]}.",
    )
    ap.add_argument("--min-overlap", type=int, default=2)
    ap.add_argument("--min-weight", type=float, default=0.08)
    ap.add_argument("--top-k", type=int, default=8)
    args = ap.parse_args()
    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)
    links = build_links(
        data,
        min_overlap=args.min_overlap,
        min_weight=args.min_weight,
        top_k=args.top_k,
    )
    print(
        json.dumps(
            [
                {
                    "a_id": link.a_id,
                    "b_id": link.b_id,
                    "weight": link.weight,
                    "shared": list(link.shared),
                }
                for link in links
            ],
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
