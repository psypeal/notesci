"""Materials ingestion: chunk + embed + persist.

Single entrypoint :func:`ingest_text` keeps the pipeline composable so
the PDF / URL / Zotero / Notion adapters reuse it by handing in
already-extracted text. :func:`extract_pdf_text` and
:func:`extract_html_text` are sync (pypdf, trafilatura); call sites
should run them in a thread executor for large inputs.
:func:`fetch_url_bytes` is async (httpx) and streams with a size cap.
"""
from __future__ import annotations

import asyncio
import io
import ipaddress
import logging
import os
import re
import socket
from dataclasses import dataclass, field
from urllib.parse import urlparse
from uuid import UUID
from xml.etree import ElementTree as ET

import httpx
import psycopg
import trafilatura
from langchain_core.embeddings import Embeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pgvector.psycopg import register_vector_async
from psycopg.types.json import Jsonb
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .agent.embeddings import make_embedding_model

log = logging.getLogger(__name__)

# Conservative defaults. Tunable later when we look at retrieval quality.
_CHUNK_SIZE = 1000
_CHUNK_OVERLAP = 150
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=_CHUNK_SIZE, chunk_overlap=_CHUNK_OVERLAP
)


@dataclass
class IngestResult:
    material_id: UUID
    chunk_count: int


@dataclass
class PdfExtraction:
    text: str
    page_count: int


def extract_pdf_text(contents: bytes) -> PdfExtraction:
    """Synchronous PDF text extraction. Wrap with ``run_in_executor`` for
    large files to keep the FastAPI event loop responsive.

    Raises ``ValueError`` for malformed PDFs. The caller is responsible
    for the magic-byte check before calling — pypdf will also reject,
    but we want a clean error before paying parser cost.
    """
    try:
        reader = PdfReader(io.BytesIO(contents))
        pages = [(p.extract_text() or "") for p in reader.pages]
    except (PdfReadError, Exception) as e:  # pypdf raises a few flavours
        raise ValueError(f"failed to parse pdf: {e}") from e
    return PdfExtraction(text="\n\n".join(pages).strip(), page_count=len(pages))


async def ingest_text(
    conn: psycopg.AsyncConnection,
    *,
    project_id: UUID,
    text: str,
    title: str | None = None,
    source_type: str = "text",
    uri: str | None = None,
    metadata: dict | None = None,
    embedder: Embeddings | None = None,
    original_bytes: bytes | None = None,
    original_mime: str | None = None,
    commit: bool = True,
) -> IngestResult:
    """Chunk ``text``, embed each chunk, and persist a material + its chunks.

    When ``original_bytes`` is supplied (PDF uploads), the raw bytes are
    retained on the materials row so the Reader pane can render the
    file. URL/text ingests pass ``None`` and the bytes column stays NULL.

    Pass ``commit=False`` when the caller needs to bundle further writes
    (lineage edges, concept rows, density-cap evictions) into the same
    transaction — otherwise this helper commits the material+chunks pair
    and a mid-bundle failure would leave half-written follow-on state.

    Returns the ``material_id`` and the number of chunks written.
    """
    pieces = _splitter.split_text(text)
    if not pieces:
        raise ValueError("nothing to ingest: text produced no chunks")

    embedder = embedder or make_embedding_model()
    vectors = await embedder.aembed_documents(pieces)
    if len(vectors) != len(pieces):
        raise RuntimeError(
            f"embedding count mismatch: {len(vectors)} vectors for {len(pieces)} chunks"
        )
    for i, vector in enumerate(vectors):
        if len(vector) != 1536:
            raise ValueError(
                f"embedding dimension mismatch for chunk {i}: expected 1536, got {len(vector)}"
            )

    await register_vector_async(conn)

    row = await (
        await conn.execute(
            "INSERT INTO materials "
            "(project_id, source_type, title, uri, metadata, original_bytes, original_mime) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                project_id,
                source_type,
                title,
                uri,
                Jsonb(metadata or {}),
                original_bytes,
                original_mime,
            ),
        )
    ).fetchone()
    material_id: UUID = row[0]

    async with conn.cursor() as cur:
        await cur.executemany(
            "INSERT INTO chunks (material_id, ord, text, embedding) "
            "VALUES (%s, %s, %s, %s)",
            [
                (material_id, i, piece, vector)
                for i, (piece, vector) in enumerate(zip(pieces, vectors))
            ],
        )
    if commit:
        await conn.commit()

    return IngestResult(material_id=material_id, chunk_count=len(pieces))


# --- URL ingestion ----------------------------------------------------------


@dataclass
class UrlExtraction:
    text: str
    title: str | None
    final_url: str
    content_type: str | None
    # Optional source-specific metadata. Stays empty for plain HTML pages;
    # arXiv-shaped URLs populate ``arxiv_id`` so the endpoint can persist it.
    extra: dict = field(default_factory=dict)


# arXiv URL detection. Matches both new-format (YYMM.NNNNN) and old-format
# (category/YYMMNNN) IDs, with optional version suffix and either /abs/ or
# /pdf/ path. Group 1 is the canonical arXiv ID.
_ARXIV_RE = re.compile(
    r"^https?://arxiv\.org/(?:abs|pdf)/"
    r"((?:\d{4}\.\d{4,5}|[a-zA-Z\-\.]+/\d{7})(?:v\d+)?)"
    r"(?:\.pdf)?/?(?:$|[\?#])"
)


_ARXIV_API_URL = "https://export.arxiv.org/api/query"
_ARXIV_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


async def fetch_arxiv_metadata(
    arxiv_id: str, *, timeout_seconds: float = 10.0
) -> dict | None:
    """Fetch authors / abstract / DOI / category from the arXiv export API.

    Best-effort: returns ``None`` on any failure (network, parse, no entry).
    Strips the version suffix (the API returns the latest version's metadata
    regardless).
    """
    bare_id = re.sub(r"v\d+$", "", arxiv_id)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            resp = await client.get(_ARXIV_API_URL, params={"id_list": bare_id})
            resp.raise_for_status()
            xml_text = resp.text
    except Exception:
        return None

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    entry = root.find("atom:entry", _ARXIV_NS)
    if entry is None:
        return None

    def _text(el) -> str:
        return (el.text or "").strip() if el is not None else ""

    title = _text(entry.find("atom:title", _ARXIV_NS))
    title = re.sub(r"\s+", " ", title)
    if not title:
        return None
    if title.lower().startswith("error"):
        # arXiv returns a synthetic "Error" entry for unknown IDs.
        return None

    abstract = re.sub(r"\s+", " ", _text(entry.find("atom:summary", _ARXIV_NS)))
    published = _text(entry.find("atom:published", _ARXIV_NS))

    authors: list[str] = []
    for a in entry.findall("atom:author/atom:name", _ARXIV_NS):
        n = (a.text or "").strip()
        if n:
            authors.append(n)

    primary_category = ""
    cat_el = entry.find("arxiv:primary_category", _ARXIV_NS)
    if cat_el is not None:
        primary_category = cat_el.get("term") or ""

    doi = _text(entry.find("arxiv:doi", _ARXIV_NS))

    return {
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "published": published,
        "primary_category": primary_category,
        "doi": doi,
    }


def parse_arxiv_url(url: str) -> tuple[str, str] | None:
    """If ``url`` is an arXiv URL, return ``(canonical_pdf_url, arxiv_id)``.

    Returns ``None`` for non-arXiv URLs.
    """
    m = _ARXIV_RE.match(url)
    if not m:
        return None
    arxiv_id = m.group(1)
    return f"https://arxiv.org/pdf/{arxiv_id}.pdf", arxiv_id


URL_FETCH_TIMEOUT = 15.0
URL_MAX_BYTES = 10 * 1024 * 1024  # 10 MB; large enough for HTML papers, blocks abuse
URL_MAX_REDIRECTS = 3
URL_OVERALL_TIMEOUT = 30.0  # outer wait_for to defeat slow-loris chains

# Browser-like request headers. The httpx default ``python-httpx/x.y``
# User-Agent is rejected outright (403 / bot-wall) by Cloudflare-fronted
# publishers — JAMA, journal "articlepdf" endpoints, many news sites —
# so both the read-only preview and "Add to project sources" fail before
# we ever see the body. Presenting a mainstream desktop UA + the Accept
# headers a real reader sends gets us the same document a browser would.
# This does NOT defeat full interactive JS challenges (those need the
# in-app browser-preview window), but it fixes the common static case.
URL_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/pdf;q=0.9,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Cloud-metadata hostnames the resolver might happily map; we shortcut
# the rejection so attackers can't bypass via the DNS layer.
_BLOCKED_HOSTNAMES = frozenset(
    {"metadata", "metadata.google.internal", "metadata.goog"}
)
# Cloud-provider link-local IPs (covered by 169.254/16 IPv4 reject, but
# we keep an explicit list for clarity).
_BLOCKED_LITERAL_IPS = frozenset(
    {"169.254.169.254", "100.100.100.200", "fd00:ec2::254"}
)


def _ssrf_local_mode() -> bool:
    """Whether to apply the relaxed SSRF policy of the desktop build.

    The strict IP classification in :func:`_ip_is_blocked` exists for the
    (now-retired) multi-tenant hosted server, where one tenant could
    otherwise pivot the URL fetcher at another tenant's internal services
    or the cloud metadata endpoint. On the single-user desktop app the
    user *is* the trust boundary, and that classification actively breaks
    legitimate setups:

      * fake-IP VPN/proxies (Clash / sing-box / tun2socks) resolve public
        domains to reserved ranges like ``198.18.0.0/15`` — which Python
        flags ``is_private`` / ``is_reserved`` — so every fetch is rejected;
      * hosts on the user's own LAN are ``is_private`` but perfectly valid
        to ingest.

    In local mode we therefore only block the targets a proxy never remaps
    (loopback, link-local incl. cloud metadata, the unspecified address,
    and the explicit metadata literals). The desktop shell sets
    ``NOTESCI_LOCAL_MODE=1`` when it spawns the backend.
    """
    return os.environ.get("NOTESCI_LOCAL_MODE") == "1"


def _ip_is_blocked(ip: ipaddress._BaseAddress) -> bool:
    """Reject loopback / private / link-local / multicast / reserved IPs.

    Catches the obvious SSRF targets (10/8, 127/8, 169.254/16, 172.16/12,
    192.168/16, fc00::/7, fe80::/10, ::1, …) via stdlib classification
    rather than a brittle prefix list.

    In :func:`_ssrf_local_mode` only loopback, link-local, the unspecified
    address, and the metadata literals are blocked — see that function for
    why the private/reserved/multicast classes are allowed on the desktop.
    """
    # Always-blocked, regardless of mode: these are never legitimately
    # remapped by a proxy and protect the backend's own loopback surface
    # and the cloud metadata endpoints.
    if ip.is_loopback or ip.is_link_local or ip.is_unspecified:
        return True
    # ipaddress doesn't flag the AWS metadata IP as private — handled
    # by is_link_local in IPv4, but assert via the literal list too.
    if str(ip) in _BLOCKED_LITERAL_IPS:
        return True
    if _ssrf_local_mode():
        # Desktop: allow private (LAN) + reserved (fake-IP proxy ranges
        # such as 198.18.0.0/15) + multicast. The user controls their own
        # network, so there is no cross-tenant pivot to defend against.
        return False
    if ip.is_private or ip.is_multicast or ip.is_reserved:
        return True
    return False


async def is_safe_url(url: str) -> bool:
    """Return True only when ``url`` is safe to fetch from the server.

    Rejects:
      * Anything that isn't ``http://`` or ``https://``
      * Hostnames in :data:`_BLOCKED_HOSTNAMES` (metadata services)
      * Hostnames whose ``getaddrinfo`` resolves to ANY non-public
        address (loopback / private / link-local / multicast / reserved
        / cloud-metadata IPs)

    DNS rebinding mitigation: the resolver is invoked again on every
    redirect hop (the redirect-validator loop in :func:`fetch_url_bytes`
    re-calls this function), and we reject the moment *any* returned
    addrinfo entry is private. Hostname → IP is also re-validated just
    before each connection; an attacker who toggles their DNS answer
    between calls has to keep every answer public.

    The resolver is offloaded to a thread via ``asyncio.to_thread`` so
    a slow upstream nameserver doesn't block the event loop.
    """
    try:
        p = urlparse(url)
    except Exception:
        return False
    if p.scheme not in ("http", "https"):
        return False
    host = (p.hostname or "").strip().lower()
    if not host:
        return False
    if host in _BLOCKED_HOSTNAMES:
        return False
    # Try to parse the host literally as an IP first — bypasses the
    # resolver for cases like ``http://127.0.0.1/`` and
    # ``http://[::1]/``.
    try:
        literal = ipaddress.ip_address(host)
        return not _ip_is_blocked(literal)
    except ValueError:
        pass

    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except socket.gaierror:
        # Unresolvable host: fail closed. httpx would also fail, but
        # this gives the caller a clean rejection.
        return False
    if not infos:
        return False
    # Reject if ANY returned addrinfo is non-public. An attacker who
    # serves a round-robin record mixing 8.8.8.8 + 127.0.0.1 should not
    # win the race even if httpx happens to pick the public one.
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            return False
        if _ip_is_blocked(ip):
            return False
    return True


async def _fetch_once(
    client: httpx.AsyncClient, url: str, *, max_bytes: int
) -> httpx.Response:
    """Single non-following GET, capped by ``max_bytes``."""
    async with client.stream("GET", url) as resp:
        # We need to read the body inside the stream context to consume it.
        data = bytearray()
        async for chunk in resp.aiter_bytes():
            data.extend(chunk)
            if len(data) > max_bytes:
                raise ValueError("response too large")
        # Stash on the response so the caller doesn't re-stream.
        resp._notesci_body = bytes(data)  # type: ignore[attr-defined]
        return resp


async def _follow_redirects(
    client: httpx.AsyncClient, url: str, *, max_bytes: int
) -> tuple[bytes, str | None, str]:
    """Manual redirect-following loop. Re-validates each hop's URL through
    :func:`is_safe_url` so an open redirector at a public host can't
    pivot us at an internal IP.
    """
    current = url
    for hop in range(URL_MAX_REDIRECTS + 1):
        # Re-validate on every hop. Per-hop resolution is required for
        # DNS-rebinding defense — the first validation may have hit a
        # public IP, but the next answer for the same name could be
        # private.
        if not await is_safe_url(current):
            raise ValueError("url not allowed")
        resp = await _fetch_once(client, current, max_bytes=max_bytes)
        body = getattr(resp, "_notesci_body", b"")
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("location")
            if not location:
                raise ValueError("redirect without location")
            # Resolve relative redirects against the current URL.
            current = str(httpx.URL(current).join(location))
            continue
        if resp.is_error:
            resp.raise_for_status()
        return body, resp.headers.get("content-type"), current
    raise ValueError("too many redirects")


async def fetch_url_bytes(
    url: str,
    *,
    timeout_seconds: float = URL_FETCH_TIMEOUT,
    max_bytes: int = URL_MAX_BYTES,
) -> tuple[bytes, str | None, str]:
    """Fetch ``url``. Returns ``(body, content_type, final_url)``.

    Raises ``ValueError`` for SSRF-rejected hosts (including the redirect
    chain), oversize responses, or overall-timeout. Network / HTTP
    failures propagate as ``httpx.HTTPError`` so the caller can show a
    useful error code.
    """
    if not await is_safe_url(url):
        raise ValueError("url not allowed")

    async def _run() -> tuple[bytes, str | None, str]:
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=timeout_seconds,
            headers=URL_FETCH_HEADERS,
        ) as client:
            return await _follow_redirects(client, url, max_bytes=max_bytes)

    try:
        return await asyncio.wait_for(_run(), timeout=URL_OVERALL_TIMEOUT)
    except asyncio.TimeoutError as e:
        raise ValueError("url fetch timed out") from e


def extract_html_text(html_or_text: str) -> tuple[str, str | None]:
    """Sync HTML-to-article extraction. Returns (text, title|None)."""
    text = trafilatura.extract(html_or_text) or ""
    title: str | None = None
    try:
        md = trafilatura.extract_metadata(html_or_text)
        if md and getattr(md, "title", None):
            title = md.title
    except Exception:
        pass
    return text.strip(), title


async def fetch_and_extract_url(url: str) -> UrlExtraction:
    arxiv = parse_arxiv_url(url)
    if arxiv is not None:
        pdf_url, arxiv_id = arxiv
        # Fetch the PDF and the arXiv API metadata in parallel. Metadata is
        # best-effort: if the API call fails or times out, fetch_arxiv_metadata
        # returns None and we just have a less-rich citation.
        (pdf_result, arxiv_meta) = await asyncio.gather(
            fetch_url_bytes(pdf_url),
            fetch_arxiv_metadata(arxiv_id),
        )
        body, ct, final_url = pdf_result
        extra: dict = {"arxiv_id": arxiv_id}
        if arxiv_meta:
            extra["arxiv_meta"] = arxiv_meta

        # arXiv occasionally serves an HTML interstitial (e.g. abuse rate
        # limit / takedown). If we didn't get a PDF, fall back to HTML
        # extraction on whatever we did receive rather than crashing.
        if body.startswith(b"%PDF-"):
            extraction = await asyncio.get_running_loop().run_in_executor(
                None, extract_pdf_text, body
            )
            extra["pages"] = extraction.page_count
            title = (
                arxiv_meta["title"] if arxiv_meta and arxiv_meta.get("title")
                else f"arXiv:{arxiv_id}"
            )
            return UrlExtraction(
                text=extraction.text,
                title=title,
                final_url=final_url,
                content_type=ct,
                extra=extra,
            )
        # Fallthrough: treat as HTML
        html = body.decode("utf-8", errors="replace")
        text, html_title = await asyncio.get_running_loop().run_in_executor(
            None, extract_html_text, html
        )
        extra["arxiv_pdf_unavailable"] = True
        title = (
            arxiv_meta["title"] if arxiv_meta and arxiv_meta.get("title")
            else html_title or f"arXiv:{arxiv_id}"
        )
        return UrlExtraction(
            text=text,
            title=title,
            final_url=final_url,
            content_type=ct,
            extra=extra,
        )

    body, ct, final_url = await fetch_url_bytes(url)
    # Publisher "articlepdf" links and bare ``.pdf`` URLs hand back a PDF
    # even though the URL isn't arXiv. Decoding those bytes as UTF-8 and
    # running the HTML extractor yields empty text and a confusing "that
    # source did not expose readable text". Detect by magic bytes /
    # content-type and route through the PDF extractor instead.
    is_pdf = body.startswith(b"%PDF-") or (ct or "").lower().startswith(
        "application/pdf"
    )
    if is_pdf:
        extraction = await asyncio.get_running_loop().run_in_executor(
            None, extract_pdf_text, body
        )
        return UrlExtraction(
            text=extraction.text,
            title=None,
            final_url=final_url,
            content_type=ct,
            extra={"pages": extraction.page_count},
        )
    html = body.decode("utf-8", errors="replace")
    text, title = await asyncio.get_running_loop().run_in_executor(
        None, extract_html_text, html
    )
    return UrlExtraction(
        text=text, title=title, final_url=final_url, content_type=ct
    )
