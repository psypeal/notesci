import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
// Vite-friendly worker URL — `?url` returns the bundled asset path so
// pdfjs's worker spins up without a CDN dependency.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Icons } from '../icons'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

/**
 * Module-level cache of parsed pdf.js documents, keyed by the Blob
 * instance the user opened them from. ReaderPane unmounts when the
 * user switches layouts, which without a cache would force a fresh
 * getDocument() round-trip every time — that's the multi-hundred-ms
 * "Loading PDF…" flash on every re-entry into reader mode.
 *
 * With the cache + ReaderPane's matching blob cache (same Blob
 * instance handed back on re-entry), PdfReader sees the already-
 * parsed PDFDocumentProxy and skips straight to canvas paint.
 *
 * Capped aggressively (4 entries) because each parsed doc pins its
 * source bytes + worker scratch in memory. LRU eviction destroys
 * the dropped doc and revokes its object URL.
 */
const MAX_DOC_CACHE = 4
interface CachedDoc {
  doc: pdfjsLib.PDFDocumentProxy
  url: string
}
const docCache = new Map<Blob, CachedDoc>()
const docLru: Blob[] = []
function touchDocLru(blob: Blob) {
  const i = docLru.indexOf(blob)
  if (i >= 0) docLru.splice(i, 1)
  docLru.push(blob)
}
function evictOldestDocs() {
  while (docLru.length > MAX_DOC_CACHE) {
    const drop = docLru.shift()
    if (!drop) break
    const entry = docCache.get(drop)
    if (entry) {
      docCache.delete(drop)
      try { void entry.doc.destroy() } catch { /* ignore */ }
      try { URL.revokeObjectURL(entry.url) } catch { /* ignore */ }
    }
    snapshotCache.delete(drop)
  }
}
/** Drop a specific cached doc — called when the source material is
 *  deleted so a subsequent re-ingest doesn't render stale bytes. */
export function invalidateDocByBlob(blob: Blob) {
  const entry = docCache.get(blob)
  if (!entry) return
  docCache.delete(blob)
  const i = docLru.indexOf(blob)
  if (i >= 0) docLru.splice(i, 1)
  try { void entry.doc.destroy() } catch { /* ignore */ }
  try { URL.revokeObjectURL(entry.url) } catch { /* ignore */ }
  snapshotCache.delete(blob)
}

/** Wipe every cached parsed PDF + its blob URL + saved canvas snapshot.
 *  Invoked from `signOut()` so the next user on this browser can't see
 *  the previous user's documents still painted on a stale canvas. Each
 *  cached doc gets its worker transport torn down and its object URL
 *  revoked so the memory + handles are released eagerly — leaving them
 *  to GC would be functionally correct but visible in DevTools. */
export function clearPdfCaches() {
  for (const entry of docCache.values()) {
    try { void entry.doc.destroy() } catch { /* ignore */ }
    try { URL.revokeObjectURL(entry.url) } catch { /* ignore */ }
  }
  docCache.clear()
  docLru.length = 0
  snapshotCache.clear()
}

/**
 * Per-blob snapshot of the last-rendered canvas state. Saved on
 * unmount; rendered as a backdrop on the next mount until pdf.js
 * finishes the fresh paint. This is what eliminates the "blank
 * canvas → content" flash that the doc cache introduced — without
 * it, every chat→reader toggle showed an empty-page flicker for the
 * 100–200 ms the canvas needs to repaint, even though the parsed
 * doc was in memory.
 *
 * Stored as a low-quality JPEG dataURL because we only need a
 * placeholder; the fresh canvas overwrites it once ready. Capped
 * implicitly by the doc cache (eviction removes the snapshot too).
 */
interface CanvasSnapshot {
  dataUrl: string
  cssWidth: number
  cssHeight: number
}
// Per-page snapshot cache. The outer key is the source Blob, the inner
// key is the 1-based page number — continuous-scroll mode mounts every
// page from the same Blob simultaneously, so a single-level Blob→snapshot
// map would have them all reuse whichever page's snapshot was written
// last and paint the wrong backdrop on most pages until pdf.js repainted
// them. The per-page key keeps each page's backdrop matched to its own
// content.
const snapshotCache = new Map<Blob, Map<number, CanvasSnapshot>>()
function getSnapshot(blob: Blob, page: number): CanvasSnapshot | null {
  return snapshotCache.get(blob)?.get(page) ?? null
}
function setSnapshot(blob: Blob, page: number, s: CanvasSnapshot) {
  let inner = snapshotCache.get(blob)
  if (!inner) {
    inner = new Map()
    snapshotCache.set(blob, inner)
  }
  inner.set(page, s)
}

/**
 * Inline PDF reader powered by pdf.js.
 *
 * Why pdf.js over an iframe:
 *  - Consistent rendering across browsers (Firefox/Chromium/Safari all
 *    render the same way — the native viewer disagrees on toolbar,
 *    selection model, and text-layer behaviour).
 *  - We control the toolbar (page nav, zoom, download, fit-width) so it
 *    matches the rest of the workspace chrome.
 *  - The text layer is real <span>s — selections and copy/paste produce
 *    actual text from the document, and the layer can be augmented with
 *    highlight overlays in a future iteration without re-rendering.
 *
 * Page rendering is incremental: we only mount canvases for the current
 * page (and its immediate neighbours when scrolled into view via the
 * built-in scroll container). Memory stays bounded for large papers
 * (200+ pages) which is the main reason iframes can stutter.
 */
export interface PdfHighlight {
  /** Stable annotation id, used as the React key on the painted block
   *  and as the argument when the user clicks the × to delete it. */
  id: string
  /** The exact passage the user highlighted, as the substring of the
   *  page text. We match this against the concatenated text-layer span
   *  content to recover its position on screen. */
  text: string
  /** Optional page-local normalized rectangles captured from the user's
   *  actual browser selection. New annotations use this instead of text
   *  re-matching, which avoids over-painting entire pdf.js spans and
   *  keeps highlights stable across duplicate phrases. */
  rects?: PdfSelectionRect[]
  /** Translucent RGBA color to paint behind the matching spans. */
  overlay: string
}
export interface PdfSelectionRect {
  page: number
  left: number
  top: number
  width: number
  height: number
}
export interface PdfNote {
  /** Stable annotation id. */
  id: string
  /** Full note body. May start with "> quoted passage\n\n…" when the
   *  note was attached to a text selection — the quoted line is used
   *  to anchor the sticky note's vertical position. */
  text: string
  /** Same normalized PDF selection geometry used by highlights. For
   *  notes, the first rect anchors the sticky marker when no explicit
   *  dragged position exists. */
  rects?: PdfSelectionRect[]
  /** User-dragged position in canvas-local CSS pixels. Absent means
   *  use the default right-margin anchor. */
  position?: { left: number; top: number }
}

type LocalRect = { left: number; top: number; right: number; bottom: number }

const MIN_TEXT_RECT = 0.5
const charRectCache = new WeakMap<Text, (LocalRect | null | undefined)[]>()

function domRectToLocal(r: DOMRect): LocalRect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

function rangeTextNodeRects(node: Text, start: number, end: number): LocalRect[] {
  const out: LocalRect[] = []
  const part = document.createRange()
  part.setStart(node, start)
  part.setEnd(node, end)
  for (const r of part.getClientRects()) {
    out.push(domRectToLocal(r))
  }
  part.detach()
  return out
}

function unionRects(rects: LocalRect[]) {
  let out: LocalRect | null = null
  for (const r of rects) {
    if (r.right - r.left < MIN_TEXT_RECT || r.bottom - r.top < MIN_TEXT_RECT) continue
    if (out) {
      out.left = Math.min(out.left, r.left)
      out.top = Math.min(out.top, r.top)
      out.right = Math.max(out.right, r.right)
      out.bottom = Math.max(out.bottom, r.bottom)
    } else {
      out = { ...r }
    }
  }
  return out
}

function charRect(node: Text, index: number): LocalRect | null {
  let cached = charRectCache.get(node)
  if (!cached) {
    cached = []
    charRectCache.set(node, cached)
  }
  if (cached[index] !== undefined) return cached[index] ?? null
  const part = document.createRange()
  part.setStart(node, index)
  part.setEnd(node, index + 1)
  const rect = unionRects([...part.getClientRects()].map(domRectToLocal))
  part.detach()
  cached[index] = rect
  return rect
}

function sameVisualLine(a: LocalRect, b: LocalRect) {
  const ah = a.bottom - a.top
  const bh = b.bottom - b.top
  return (
    Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <
    Math.max(2, Math.min(ah, bh) * 0.35)
  )
}

function addToLine(lines: LocalRect[], r: LocalRect) {
  if (r.right - r.left < MIN_TEXT_RECT || r.bottom - r.top < MIN_TEXT_RECT) return
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!sameVisualLine(line, r)) continue
    line.left = Math.min(line.left, r.left)
    line.top = Math.min(line.top, r.top)
    line.right = Math.max(line.right, r.right)
    line.bottom = Math.max(line.bottom, r.bottom)
    return
  }
  lines.push({ ...r })
}

function measuredTextNodeRects(node: Text, start: number, end: number): LocalRect[] {
  if (start >= end) return []
  const lines: LocalRect[] = []
  for (let i = start; i < end; i += 1) {
    const r = charRect(node, i)
    if (r) addToLine(lines, r)
  }
  return lines.length > 0 ? mergeLineRects(lines) : rangeTextNodeRects(node, start, end)
}

function mergeLineRects(rects: LocalRect[]) {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left)
  const merged: LocalRect[] = []
  for (const r of sorted) {
    if (r.right - r.left < MIN_TEXT_RECT || r.bottom - r.top < MIN_TEXT_RECT) continue
    const last = merged[merged.length - 1]
    const height = r.bottom - r.top
    const lastHeight = last ? last.bottom - last.top : 0
    const sameLine = last && sameVisualLine(last, r)
    const closeGap =
      last && r.left <= last.right + Math.max(6, Math.min(height, lastHeight) * 0.35)
    if (sameLine && closeGap) {
      last.left = Math.min(last.left, r.left)
      last.top = Math.min(last.top, r.top)
      last.right = Math.max(last.right, r.right)
      last.bottom = Math.max(last.bottom, r.bottom)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

function tightenTextRect(r: LocalRect): LocalRect | null {
  const width = r.right - r.left
  const height = r.bottom - r.top
  if (width < MIN_TEXT_RECT || height < MIN_TEXT_RECT) return null
  const targetHeight = Math.min(height, Math.max(4, height * 0.68))
  const yInset = (height - targetHeight) / 2
  const xInset = Math.min(1, width * 0.01)
  const next = {
    left: r.left + xInset,
    top: r.top + yInset,
    right: r.right - xInset,
    bottom: r.bottom - yInset,
  }
  if (next.right - next.left < 0.5 || next.bottom - next.top < 0.5) return r
  return next
}

function textNodeSelectionRects(range: Range, root: HTMLElement): LocalRect[] {
  const out: LocalRect[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.data) continue
    try {
      if (!range.intersectsNode(node)) continue
    } catch {
      continue
    }
    let start = 0
    let end = node.data.length
    if (range.startContainer === node) start = Math.min(range.startOffset, end)
    if (range.endContainer === node) end = Math.min(range.endOffset, end)
    if (start >= end) continue
    out.push(...measuredTextNodeRects(node, start, end))
  }
  return mergeLineRects(out)
}

export function PdfReader({
  blob,
  title,
  onError,
  onNotice,
  highlights = [],
  notes = [],
  onDelete,
  onMoveNote,
  onEditNote,
}: {
  blob: Blob
  title: string
  onError?: (msg: string) => void
  /** Optional positive-status callback. Separate from ``onError`` so
   *  Export-success messages don't read as "PDF render failed". */
  onNotice?: (msg: string) => void
  highlights?: PdfHighlight[]
  notes?: PdfNote[]
  /** Called with an annotation id when the user clicks × on a
   *  highlight overlay or on a sticky note. */
  onDelete?: (id: string) => void
  /** Called when the user drags a sticky note marker to a new
   *  position. Coordinates are canvas-local CSS pixels. */
  onMoveNote?: (id: string, position: { left: number; top: number }) => void
  /** Called when the user edits + saves a sticky-note body. The new
   *  body replaces the existing annotation text (the "> quoted
   *  passage" header is preserved upstream). */
  onEditNote?: (id: string, text: string) => void
}) {
  // Initialize from the doc cache synchronously so a cached re-mount
  // (user toggling between chat and reader on the same PDF) already
  // has `pdf` populated on the first render — no "Loading PDF…"
  // flash even for one frame.
  const initialCached = docCache.get(blob)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(
    initialCached?.doc ?? null,
  )
  const [pageCount, setPageCount] = useState(initialCached?.doc.numPages ?? 0)
  // The page the toolbar reads as "current" — driven by IntersectionObserver
  // on the per-page wrappers in continuous-scroll mode. Jumping (input box
  // or prev/next button) scrolls the container, which then re-fires the
  // observer and converges this state.
  const [currentPage, setCurrentPage] = useState(1)
  // Editable page-number input. Decoupled from `currentPage` so the user
  // can type a multi-digit page without each keystroke fighting the
  // scroll-driven indicator update.
  const [pageInput, setPageInput] = useState('1')
  const [pageInputFocused, setPageInputFocused] = useState(false)
  const [scale, setScale] = useState(1.1)
  const [fitWidth, setFitWidth] = useState(true)
  const [loading, setLoading] = useState(!initialCached)
  // In-document find. State is intentionally lightweight: pageTexts is
  // a one-shot cache built from getTextContent() per page on first use,
  // matches is the flat list of {page, index} hits for findQuery, and
  // matchCursor points at the currently-active hit.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [pageTexts, setPageTexts] = useState<string[] | null>(null)
  const [matches, setMatches] = useState<{ page: number; index: number }[]>([])
  const [matchCursor, setMatchCursor] = useState(0)
  const findInputRef = useRef<HTMLInputElement | null>(null)

  const blobUrlRef = useRef<string | null>(null)
  // Latest-ref pattern: we want the load effect to re-run ONLY when the
  // blob identity changes, never when the parent passes a fresh arrow
  // function for onError. Without this, every parent re-render
  // (e.g. selection-change tracking in ReaderPane) destroys the PDF
  // doc, blanks the text layer, and reloads — causing heavy flicker and
  // killing any in-progress text selection.
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  const onNoticeRef = useRef(onNotice)
  useEffect(() => {
    onNoticeRef.current = onNotice
  }, [onNotice])

  useEffect(() => {
    setCurrentPage(1)
    setPageInput('1')
    let cancelled = false
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null
    // Cache hit: the parsed PDFDocumentProxy is already in memory.
    // Bypass the URL + getDocument round-trip entirely — the canvas
    // paints from the cached doc on the next layout effect.
    const cached = docCache.get(blob)
    if (cached) {
      blobUrlRef.current = cached.url
      setPdf(cached.doc)
      setPageCount(cached.doc.numPages)
      setLoading(false)
      touchDocLru(blob)
      return () => {
        // Cached doc + URL stay alive — eviction owns teardown.
        cancelled = true
      }
    }

    setLoading(true)
    const url = URL.createObjectURL(blob)
    blobUrlRef.current = url

    void (async () => {
      try {
        task = pdfjsLib.getDocument({ url })
        const doc = await task.promise
        if (cancelled) {
          await doc.destroy()
          URL.revokeObjectURL(url)
          return
        }
        // Cache for the next remount.
        docCache.set(blob, { doc, url })
        touchDocLru(blob)
        evictOldestDocs()
        setPdf(doc)
        setPageCount(doc.numPages)
      } catch (err) {
        if (!cancelled) {
          onErrorRef.current?.(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      // CRITICAL: only destroy the loading task when the doc DIDN'T
      // end up cached. PDFDocumentLoadingTask.destroy() tears down
      // the worker transport, and the cached doc relies on that
      // same transport for getPage() / getTextContent() — destroying
      // it produces a "Cannot read 'sendWithPromise' of null" the
      // next time the cached doc is used. When the doc is cached,
      // the task's transport must stay alive until eviction.
      if (!docCache.has(blob)) {
        task?.destroy()
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
      }
      blobUrlRef.current = null
    }
  }, [blob])

  const onDownload = async () => {
    // WebKitGTK doesn't reliably honour <a download> for blob URLs —
    // clicks fall through silently. When running under Tauri we route
    // to the Rust ``export_file`` command which opens a native folder
    // picker via rfd and writes the PDF there using the current title
    // as the filename. In a plain browser fallback we still try the
    // anchor click.
    const suggested = (title || 'document').endsWith('.pdf')
      ? title
      : `${title || 'document'}.pdf`
    type TauriGlobal = {
      __TAURI__?: {
        core?: {
          invoke?: (cmd: string, args: unknown) => Promise<unknown>
        }
      }
      __TAURI_INTERNALS__?: {
        invoke?: (cmd: string, args: unknown) => Promise<unknown>
      }
    }
    const tauri = window as unknown as TauriGlobal
    const invoke = tauri.__TAURI__?.core?.invoke ?? tauri.__TAURI_INTERNALS__?.invoke
    console.info('[export] click; tauri invoke present:', !!invoke)
    const fallbackDownload = () => {
      const a = document.createElement('a')
      let revokeUrl: string | null = null
      if (blobUrlRef.current) {
        a.href = blobUrlRef.current
      } else {
        revokeUrl = URL.createObjectURL(blob)
        a.href = revokeUrl
      }
      a.download = suggested
      a.target = '_blank'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      if (revokeUrl) window.setTimeout(() => URL.revokeObjectURL(revokeUrl), 1000)
    }
    if (invoke) {
      try {
        const buf = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        const CHUNK = 0x8000
        for (let i = 0; i < buf.length; i += CHUNK) {
          bin += String.fromCharCode.apply(
            null,
            Array.from(buf.subarray(i, i + CHUNK)),
          )
        }
        const base64 = btoa(bin)
        console.info('[export] invoking export_file, bytes:', buf.length)
        const savedPath = (await invoke('export_file', {
          suggestedName: suggested,
          base64,
        })) as string | null
        console.info('[export] saved to:', savedPath)
        if (savedPath) onNoticeRef.current?.(`Exported to ${savedPath}`)
        else onNoticeRef.current?.('Export cancelled.')
        return
      } catch (err) {
        console.error('[export] export_file failed', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        onNoticeRef.current?.(
          `Native export unavailable (${errMsg || 'unknown error'}). Falling back to browser download.`,
        )
        fallbackDownload()
        return
      }
    }
    // Browser fallback — open in a new tab so WebKit's native handler
    // can offer download.
    fallbackDownload()
  }

  // Scroll-to-page plumbing for continuous mode. Each rendered PdfPage
  // registers its outermost wrapper element here so the toolbar's
  // prev/next + jump-by-number controls can scroll it into view, and
  // the IntersectionObserver below knows which DOM nodes to watch for
  // visibility transitions.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const registerPageRef = useCallback(
    (page: number, el: HTMLDivElement | null) => {
      if (el) pageRefs.current.set(page, el)
      else pageRefs.current.delete(page)
    },
    [],
  )

  // Edge-auto-scroll during drag-selection. PDFs render one text
  // layer per page, so dragging from page N into the gap between
  // pages — or off the bottom of the viewport entirely — used to feel
  // like "the cursor falls out of scope": the browser stops extending
  // the selection because the pointer is no longer over any
  // selectable text. We solve this at the scroll-container level: on
  // every drag-move, if the pointer is within ``EDGE_PX`` of the top
  // or bottom edge, scroll the container by an amount proportional to
  // proximity. The browser then sees fresh text beneath the pointer
  // and extends the selection naturally onto the next/previous page.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const EDGE_PX = 80
    const MAX_DELTA = 22
    let dragging = false
    let raf = 0
    let lastY = 0
    const tick = () => {
      raf = 0
      if (!dragging) return
      const rect = container.getBoundingClientRect()
      const fromTop = lastY - rect.top
      const fromBot = rect.bottom - lastY
      let delta = 0
      if (fromTop < EDGE_PX && fromTop >= 0) {
        // Closer to the edge → faster scroll.
        delta = -Math.round(((EDGE_PX - fromTop) / EDGE_PX) * MAX_DELTA)
      } else if (fromBot < EDGE_PX && fromBot >= 0) {
        delta = Math.round(((EDGE_PX - fromBot) / EDGE_PX) * MAX_DELTA)
      }
      if (delta !== 0) {
        container.scrollTop += delta
        // Keep ticking while the pointer is parked near the edge —
        // the browser only fires `pointermove` on actual movement, but
        // a stationary cursor at the edge should still scroll.
        raf = requestAnimationFrame(tick)
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = true
      lastY = e.clientY
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      lastY = e.clientY
      if (raf === 0) raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      dragging = false
      if (raf !== 0) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    container.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      stop()
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  const scrollToPage = useCallback((target: number) => {
    if (!Number.isFinite(target)) return
    const el = pageRefs.current.get(target)
    const container = scrollContainerRef.current
    if (!el || !container) return
    // Pin the page to the top of the scroll container. Using
    // `scrollIntoView({block: 'start'})` would also work but isn't
    // honoured inside a flex column with overflow on some browsers
    // when the parent's start padding differs from the container —
    // computing the delta manually is bulletproof and lets us subtract
    // the container's `padding-top` so the page edge isn't tucked
    // under the inner padding.
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const delta = eRect.top - cRect.top
    const styles = window.getComputedStyle(container)
    const padTop = parseFloat(styles.paddingTop || '0') || 0
    container.scrollTo({
      top: container.scrollTop + delta - padTop,
      behavior: 'smooth',
    })
  }, [])

  // Track which page is currently in view. Each PdfPage wrapper carries
  // a `data-page` attribute that we read on intersection — the page whose
  // wrapper has the largest visible area "wins" and drives the toolbar
  // indicator. Falling back to the closest-to-top page (in case nothing
  // intersects above the threshold on a long zoomed-in page) keeps the
  // indicator updating during fast scrolls.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !pdf) return
    const visibility = new Map<number, number>()
    const update = () => {
      let best = currentPage
      let bestRatio = -1
      for (const [page, ratio] of visibility) {
        if (ratio > bestRatio) {
          bestRatio = ratio
          best = page
        }
      }
      setCurrentPage((p) => (p === best ? p : best))
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page)
          if (!Number.isFinite(n)) continue
          if (e.isIntersecting) visibility.set(n, e.intersectionRatio)
          else visibility.delete(n)
        }
        update()
      },
      {
        root: container,
        // Multiple thresholds so the ratio is updated smoothly as the
        // user scrolls through tall pages.
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      },
    )
    for (const el of pageRefs.current.values()) io.observe(el)
    return () => io.disconnect()
    // Re-observe whenever the page count changes (i.e. doc switched).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageCount])

  // Sync the input box from the scroll-driven `currentPage` — but only
  // when the user isn't actively editing it. Without the focus guard,
  // typing "12" would jump to page 1 mid-keystroke (after one digit)
  // and the scroll handler would then clobber the input back to "1".
  useEffect(() => {
    if (!pageInputFocused) setPageInput(String(currentPage))
  }, [currentPage, pageInputFocused])

  const commitPageInput = () => {
    const n = parseInt(pageInput, 10)
    if (!Number.isFinite(n) || n < 1 || n > pageCount) {
      setPageInput(String(currentPage))
      return
    }
    scrollToPage(n)
  }

  // Reset find state whenever the document changes.
  useEffect(() => {
    setPageTexts(null)
    setMatches([])
    setMatchCursor(0)
  }, [pdf])

  // Lazy text extraction. We pull text content for every page the first
  // time the user opens find, then keep it in state — typical PDFs
  // are a few hundred KB of text and the cost beats re-extracting on
  // every keystroke. Extraction runs in parallel across pages.
  const ensurePageTexts = useCallback(async (): Promise<string[]> => {
    if (pageTexts) return pageTexts
    if (!pdf) return []
    const texts = await Promise.all(
      Array.from({ length: pdf.numPages }, async (_, i) => {
        try {
          const page = await pdf.getPage(i + 1)
          const content = await page.getTextContent()
          return content.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ')
        } catch {
          return ''
        }
      }),
    )
    setPageTexts(texts)
    return texts
  }, [pageTexts, pdf])

  // Recompute matches whenever the query (or freshly-loaded page texts)
  // changes. Case-insensitive substring search — good enough for chat
  // citations; full regex / whole-word options can come later.
  const runFind = useCallback(
    async (query: string) => {
      const q = query.trim()
      if (!q) {
        setMatches([])
        setMatchCursor(0)
        return
      }
      const texts = await ensurePageTexts()
      const needle = q.toLowerCase()
      const hits: { page: number; index: number }[] = []
      for (let p = 0; p < texts.length; p++) {
        const hay = texts[p].toLowerCase()
        let start = 0
        while (start <= hay.length) {
          const idx = hay.indexOf(needle, start)
          if (idx < 0) break
          hits.push({ page: p + 1, index: idx })
          start = idx + needle.length
          // Cap matches per page so a pathological one-char query doesn't
          // blow up state. 200 matches is plenty for chat citations.
          if (hits.length > 500) break
        }
        if (hits.length > 500) break
      }
      setMatches(hits)
      setMatchCursor(0)
      if (hits.length > 0) scrollToPage(hits[0].page)
    },
    [ensurePageTexts, scrollToPage],
  )

  // Re-search when the query changes. Debounce so each keystroke
  // doesn't trigger a full scan on large PDFs.
  useEffect(() => {
    if (!findOpen) return
    const t = setTimeout(() => void runFind(findQuery), 120)
    return () => clearTimeout(t)
  }, [findOpen, findQuery, runFind])

  const gotoMatch = (offset: number) => {
    if (matches.length === 0) return
    const next = (matchCursor + offset + matches.length) % matches.length
    setMatchCursor(next)
    scrollToPage(matches[next].page)
  }

  // ⌘F / Ctrl+F — open the find bar and focus the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f'
      if (!isFind) {
        if (e.key === 'Escape' && findOpen) {
          setFindOpen(false)
          setFindQuery('')
        }
        return
      }
      e.preventDefault()
      setFindOpen(true)
      // Defer the focus to the next tick so the input has mounted.
      queueMicrotask(() => findInputRef.current?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--color-paper-2)',
      }}
    >
      <div
        role="toolbar"
        aria-label="PDF reader controls"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--color-rule)',
          background: '#fff',
          flexShrink: 0,
          fontSize: 12,
        }}
      >
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1 || loading}
          aria-label="Previous page"
          title="Previous page"
        >
          <Icons.chevDown size={12} style={{ transform: 'rotate(90deg)' }} />
        </button>
        {/* Page-number input + total. The input is editable so the user
            can type a page and press Enter to jump. While focused, the
            scroll-driven page-indicator effect skips overwriting the
            value (see the focus guard around `setPageInput`), so typing
            multi-digit numbers works smoothly. */}
        <div
          className="font-mono"
          aria-live="polite"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11.5,
            minWidth: 78,
            justifyContent: 'center',
          }}
        >
          {loading ? (
            <span>…</span>
          ) : (
            <>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label={`Jump to page (1 to ${pageCount})`}
                title={`Jump to page (1 to ${pageCount})`}
                value={pageInput}
                onFocus={(e) => {
                  setPageInputFocused(true)
                  e.target.select()
                }}
                onBlur={() => {
                  setPageInputFocused(false)
                  commitPageInput()
                }}
                onChange={(e) => {
                  // Strip non-digits as the user types — keeps the state
                  // valid without nagging the user with errors mid-input.
                  setPageInput(e.target.value.replace(/[^0-9]/g, ''))
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitPageInput()
                    ;(e.target as HTMLInputElement).blur()
                  } else if (e.key === 'Escape') {
                    setPageInput(String(currentPage))
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                style={{
                  width: Math.max(28, String(pageCount).length * 9 + 16),
                  textAlign: 'center',
                  font: 'inherit',
                  fontSize: 11.5,
                  padding: '2px 4px',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 4,
                  background: '#fff',
                  color: 'var(--color-ink)',
                }}
              />
              <span style={{ color: 'var(--color-muted)' }}>/ {pageCount}</span>
            </>
          )}
        </div>
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))}
          disabled={currentPage >= pageCount || loading}
          aria-label="Next page"
          title="Next page"
        >
          <Icons.chevDown size={12} style={{ transform: 'rotate(-90deg)' }} />
        </button>

        <div
          aria-hidden
          style={{ width: 1, height: 16, background: 'var(--color-rule)' }}
        />

        {/* Zoom cluster — −/+ flanking a dropdown of common presets +
            Fit Width. Replaces the previous three-button row so the
            user can jump to a specific zoom level without clicking the
            stepper repeatedly. */}
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={() => {
            setFitWidth(false)
            setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)))
          }}
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!fitWidth && scale <= 0.5}
        >
          −
        </button>
        <select
          aria-label="Zoom level"
          title="Zoom"
          value={fitWidth ? 'fit' : String(Math.round(scale * 100))}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'fit') {
              setFitWidth(true)
            } else {
              setFitWidth(false)
              setScale(parseInt(v, 10) / 100)
            }
          }}
          style={{
            font: 'inherit',
            fontSize: 11.5,
            padding: '2px 4px',
            border: '1px solid var(--color-rule)',
            borderRadius: 4,
            background: '#fff',
            color: 'var(--color-ink)',
            minWidth: 64,
          }}
        >
          <option value="fit">Fit width</option>
          {[50, 75, 100, 125, 150, 175, 200, 250, 300].map((p) => (
            <option key={p} value={String(p)}>
              {p}%
            </option>
          ))}
          {/* If the user is on a non-preset zoom (via +/− stepper), show
              the current value as a transient option so it doesn't
              read as "0%". */}
          {!fitWidth &&
            ![50, 75, 100, 125, 150, 175, 200, 250, 300].includes(
              Math.round(scale * 100),
            ) && (
              <option value={String(Math.round(scale * 100))}>
                {Math.round(scale * 100)}%
              </option>
            )}
        </select>
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={() => {
            setFitWidth(false)
            setScale((s) => Math.min(3, +(s + 0.1).toFixed(2)))
          }}
          aria-label="Zoom in"
          title="Zoom in"
          disabled={!fitWidth && scale >= 3}
        >
          +
        </button>

        <div
          aria-hidden
          style={{ width: 1, height: 16, background: 'var(--color-rule)' }}
        />

        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={() => {
            setFindOpen((v) => !v)
            if (!findOpen) {
              queueMicrotask(() => findInputRef.current?.focus())
            }
          }}
          aria-label="Find in document"
          aria-pressed={findOpen}
          aria-keyshortcuts="Meta+F Control+F"
          title="Find in document (⌘F)"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
          }}
        >
          <Icons.search size={12} />
          <span>Find</span>
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={onDownload}
            aria-label="Export PDF to a folder"
            title="Export to a folder…"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 10px',
            }}
          >
            <Icons.share size={12} />
            <span>Export</span>
          </button>
        </div>
      </div>
      {findOpen && (
        <div
          role="search"
          aria-label="Find in document"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderBottom: '1px solid var(--color-rule)',
            background: 'var(--color-paper-2)',
            flexShrink: 0,
            fontSize: 12,
          }}
        >
          <Icons.search size={12} />
          <input
            ref={findInputRef}
            type="text"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter') {
                e.preventDefault()
                gotoMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                setFindOpen(false)
                setFindQuery('')
              }
            }}
            placeholder="Find text in this document…"
            aria-label="Find text"
            style={{
              flex: 1,
              maxWidth: 320,
              font: 'inherit',
              fontSize: 12.5,
              padding: '4px 8px',
              border: '1px solid var(--color-rule)',
              borderRadius: 4,
              background: '#fff',
              color: 'var(--color-ink)',
            }}
          />
          <span
            className="font-mono"
            style={{ fontSize: 11, color: 'var(--color-muted)', minWidth: 80 }}
          >
            {findQuery.trim().length === 0
              ? '—'
              : matches.length === 0
                ? 'no matches'
                : `${matchCursor + 1} of ${matches.length}`}
          </span>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => gotoMatch(-1)}
            disabled={matches.length === 0}
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
          >
            <Icons.chevDown size={12} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => gotoMatch(1)}
            disabled={matches.length === 0}
            aria-label="Next match"
            title="Next match (Enter)"
          >
            <Icons.chevDown size={12} />
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
            aria-label="Close find bar"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="pdf-scroll-container"
        style={{
          flex: 1,
          overflow: 'auto',
          // Reserve scrollbar gutter space whether or not the
          // vertical scrollbar is actually rendered (see the original
          // single-page reader's rationale below). Continuous mode
          // makes the vertical scrollbar nearly always present (every
          // PDF spans more than one viewport when all pages stack),
          // but the gutter directive is still needed for narrow PDFs
          // whose total height fits in one viewport.
          scrollbarGutter: 'stable',
          padding: 16,
          // Vertical continuous layout: stack pages top-to-bottom,
          // centred horizontally. `safe center` centres pages that fit
          // and falls back to flex-start when a wide / zoomed page
          // overflows the container — preserving the "user can scroll
          // to the left edge" behaviour of the previous single-page
          // mode.
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          alignItems: 'safe center',
          gap: 16,
        }}
      >
        {pdf && !loading ? (
          // Render every page in document order. Each PdfPage renders
          // its own canvas + text-layer + annotation overlays. The
          // `pageNumber` label badge in the top-left corner is a small
          // UX hint so a user mid-scroll can confirm where they are
          // without having to look up at the toolbar.
          Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
            <PdfPage
              key={n}
              blob={blob}
              doc={pdf}
              page={n}
              pageLabel={`${n}`}
              registerRef={registerPageRef}
              scale={scale}
              fitWidth={fitWidth}
              onError={(msg) => onErrorRef.current?.(msg)}
              highlights={highlights}
              notes={notes}
              onDelete={onDelete}
              onMoveNote={onMoveNote}
              onEditNote={onEditNote}
            />
          ))
        ) : (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--color-muted)',
              padding: 32,
            }}
          >
            {loading ? 'Loading PDF…' : 'No document.'}
          </div>
        )}
      </div>
    </div>
  )
}


/**
 * One rendered page. Pdf.js draws into a <canvas>; we additionally
 * render the text layer as positioned <span>s overlaid on top so the
 * user can select + copy real text. The text layer absolutely-positions
 * relative to the canvas so they share coordinates.
 */
function PdfPage({
  blob,
  doc,
  page,
  pageLabel,
  registerRef,
  scale,
  fitWidth,
  onError,
  highlights,
  notes = [],
  onDelete,
  onMoveNote,
  onEditNote,
}: {
  blob: Blob
  doc: pdfjsLib.PDFDocumentProxy
  page: number
  /** Short string painted in the top-left corner of each page in
   *  continuous mode (e.g. "1" of N) so the user can see which page
   *  they're scrolling through without watching the toolbar. */
  pageLabel?: string
  /** Continuous-mode hook: the parent registers each page's outer
   *  wrapper so it can scroll-to-page and observe visibility for the
   *  toolbar indicator. */
  registerRef?: (page: number, el: HTMLDivElement | null) => void
  scale: number
  fitWidth: boolean
  onError: (msg: string) => void
  highlights: PdfHighlight[]
  notes?: PdfNote[]
  onDelete?: (id: string) => void
  onMoveNote?: (id: string, position: { left: number; top: number }) => void
  onEditNote?: (id: string, text: string) => void
}) {
  // Latest-ref so a fresh parent arrow function doesn't re-run the
  // render effect (which would re-trigger the cancel/redo cycle).
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  // Bump on every successful page-render so the highlight overlay
  // effect re-runs after the text-layer has been (re)populated.
  const [renderTick, setRenderTick] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Dedicated highlight overlay layer. Sits between canvas and
  // text-layer (z-index 1) so painted rectangles are visible over the
  // page but don't block the user's drag-select on the spans above.
  const highlightLayerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  // Snapshot of the previously-rendered canvas (if any) for THIS blob,
  // shown as a backdrop image while the fresh canvas paint catches up.
  // Without this, the warm cache path still showed an empty white
  // page for the 100–200 ms it took pdf.js to repaint — a visible
  // "blank → content" flash on every layout switch back to reader.
  // The snapshot is captured on the previous unmount; on this mount
  // we display the dataURL immediately, then drop it once the new
  // render completes (renderTick > 0).
  const initialSnapshot = getSnapshot(blob, page)
  const [snapshot] = useState<CanvasSnapshot | null>(initialSnapshot)

  // Track the parent's available width so fit-width zoom adapts to
  // pane-resize (Reader/Drafter resize each other via the splitter).
  //
  // CRITICAL: the initial measurement runs as a **layout** effect so
  // `containerWidth` is in sync with reality BEFORE the canvas-render
  // useEffect first fires. Previously the initial sync lived inside the
  // observer-setup useEffect — which runs after `useEffect`s of
  // descendants, meaning the render effect's first run saw
  // `containerWidth=0`, painted at the fallback scale 1.1, then
  // re-painted at fit-width once the state caught up. That double
  // render produced a visible flicker on every warm cache hit (since
  // the cache now mounts `PdfPage` on the very first render of
  // `PdfReader`).
  //
  // The debounced observer for live resizes stays in a regular
  // useEffect — 90ms coalescing keeps active window drags from
  // re-rendering the canvas on every pixel.
  useLayoutEffect(() => {
    const el = containerRef.current?.parentElement
    if (!el) return
    const w = el.clientWidth
    setContainerWidth((cur) => (cur !== w ? w : cur))
  }, [])
  useEffect(() => {
    const el = containerRef.current?.parentElement
    if (!el) return
    let timer: number | null = null
    const ro = new ResizeObserver(() => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const w = el.clientWidth
        setContainerWidth((cur) => (cur !== w ? w : cur))
      }, 90)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [])

  // Track the in-flight render so we can cancel it before starting a
  // new one. Two concurrent renders on the same canvas produce the
  // pdf.js "Cannot use the same canvas during multiple render()
  // operations" error AND the flickering the user reported, because
  // each render clears + redraws the canvas while the previous is
  // still painting.
  const inFlightRef = useRef<{
    task: ReturnType<pdfjsLib.PDFPageProxy['render']> | null
  }>({ task: null })

  // Snapshot the current canvas state on unmount so the NEXT mount
  // for this same blob can render it as a backdrop while pdf.js
  // repaints. Capturing as a low-quality JPEG keeps the dataURL
  // small (typically < 200 KB for an A4 page) — the snapshot is a
  // visual placeholder, not the canvas content itself, so quality
  // loss is invisible by the time the fresh canvas overlays it.
  //
  // The ref `canvasForSnapshotRef` mirrors `canvasRef` via a no-dep
  // effect so the cleanup closure always reads the current canvas
  // element. React detaches the regular `canvasRef` near the end of
  // unmount; a mirror ref written via an unconditional effect stays
  // valid throughout the cleanup callback.
  const canvasForSnapshotRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    canvasForSnapshotRef.current = canvasRef.current
  })

  // Selection: native browser selection drives the caret + Cmd+C, but
  // we paint our OWN halo via character-edge text-node rectangles because
  // the native ::selection painter and pdf.js text-layer rects can
  // span a full PDF line box instead of the selected glyph run. See
  // index.css for the ::selection { transparent } rule + the
  // ns-pdf-selection-layer / -rect styling.
  //
  // The custom layer is added to the page wrapper next to the textLayer
  // (z-index 4, pointer-events none) so it sits above the textLayer
  // visually but doesn't intercept pointer events.
  //
  // Overlay interception fix: the ``.selecting`` class on the textLayer
  // pairs with a CSS rule that flips highlight badges + note markers
  // to pointer-events: none during a drag. Bound on the page wrapper
  // so the toggle fires even when pointerdown lands on an overlay.
  const selectionLayerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    const layer = textLayerRef.current
    const selLayer = selectionLayerRef.current
    if (!container || !layer || !selLayer) return

    const clear = () => {
      while (selLayer.firstChild) selLayer.removeChild(selLayer.firstChild)
    }

    const paint = () => {
      const sel = window.getSelection?.()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        clear()
        return
      }
      const range = sel.getRangeAt(0)
      const cRect = container.getBoundingClientRect()
      const rects = textNodeSelectionRects(range, layer)
      const frag = document.createDocumentFragment()
      let painted = false
      for (const r of rects) {
        if (r.right - r.left < 0.5 || r.bottom - r.top < 0.5) continue
        const tight = tightenTextRect({
          left: Math.max(0, r.left - cRect.left),
          top: Math.max(0, r.top - cRect.top),
          right: Math.min(cRect.width, r.right - cRect.left),
          bottom: Math.min(cRect.height, r.bottom - cRect.top),
        })
        if (!tight) continue
        const div = document.createElement('div')
        div.className = 'ns-pdf-selection-rect'
        div.style.left = `${tight.left}px`
        div.style.top = `${tight.top}px`
        div.style.width = `${tight.right - tight.left}px`
        div.style.height = `${tight.bottom - tight.top}px`
        frag.appendChild(div)
        painted = true
      }
      clear()
      if (painted) selLayer.appendChild(frag)
    }

    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        paint()
      })
    }

    const onSelectionChange = () => schedule()

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      layer.classList.add('selecting')
    }
    const onUp = () => {
      layer.classList.remove('selecting')
      // Re-paint after the gesture so the final selection is reflected
      // (selectionchange may have already fired before the browser
      // finalised the range).
      schedule()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    container.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      container.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (raf) cancelAnimationFrame(raf)
      clear()
    }
  }, [])
  useEffect(() => {
    return () => {
      const c = canvasForSnapshotRef.current
      if (!c || c.width === 0 || c.height === 0) return
      try {
        const dataUrl = c.toDataURL('image/jpeg', 0.6)
        setSnapshot(blob, page, {
          dataUrl,
          cssWidth: parseFloat(c.style.width || '0') || c.width,
          cssHeight: parseFloat(c.style.height || '0') || c.height,
        })
      } catch {
        /* tainted canvas or quota — fall back to a blank mount */
      }
    }
  }, [blob, page])

  useEffect(() => {
    if (!canvasRef.current || !textLayerRef.current) return
    let cancelled = false

    const run = async () => {
      // Cancel any previous in-flight render before starting a new one.
      // The pdf.js render task exposes `.cancel()` which aborts the
      // canvas paint AND rejects the promise — we swallow the
      // RenderingCancelledException below.
      if (inFlightRef.current.task) {
        try {
          inFlightRef.current.task.cancel()
        } catch {
          /* ignore */
        }
        inFlightRef.current.task = null
      }

      if (!canvasRef.current || !textLayerRef.current) return
      const pageObj = await doc.getPage(page)
      if (cancelled) return
      const baseViewport = pageObj.getViewport({ scale: 1 })
      // Use the live parent width rather than the state value to absorb
      // the brief window between mount and the first ResizeObserver
      // observation. Without this, a warm cache mount whose
      // `containerWidth` state hadn't yet been synced by the layout
      // effect would render at the fallback `scale` (1.1) and then
      // immediately re-render at fit-width — the exact flicker the user
      // reported. State stays in the dep array so observer-driven
      // resizes still trigger a re-render.
      const liveWidth = containerRef.current?.parentElement?.clientWidth ?? containerWidth
      const targetScale =
        fitWidth && liveWidth > 0
          ? Math.max(0.5, (liveWidth - 32) / baseViewport.width)
          : scale
      const viewport = pageObj.getViewport({ scale: targetScale })
      const ratio = window.devicePixelRatio || 1

      const canvas = canvasRef.current
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      const ctx = canvas.getContext('2d')!
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

      const task = pageObj.render({ canvasContext: ctx, viewport, canvas })
      inFlightRef.current.task = task
      try {
        await task.promise
      } catch (err) {
        // pdf.js throws RenderingCancelledException when we cancel —
        // that's expected; suppress so React doesn't see an unhandled
        // rejection. Anything else bubbles up to onErrorRef.
        const name = (err as { name?: string })?.name
        if (name !== 'RenderingCancelledException') {
          onErrorRef.current?.(err instanceof Error ? err.message : String(err))
        }
        return
      } finally {
        if (inFlightRef.current.task === task) inFlightRef.current.task = null
      }
      if (cancelled) return

      // Text layer — render synchronously after the canvas is painted.
      const textLayer = textLayerRef.current
      if (!textLayer) return
      textLayer.innerHTML = ''
      textLayer.style.width = `${viewport.width}px`
      textLayer.style.height = `${viewport.height}px`
      // CRITICAL: pdf.js v5 spans use `calc(var(--scale-factor) * ...)`
      // for `font-size` and `transform`. If `--scale-factor` isn't set
      // on the container, those spans collapse to zero or wrong size
      // and you get the "I can only select some letters" symptom —
      // spans are misaligned with the visible glyphs, so drag-select
      // hits gaps instead of text. pdf.js's TextLayer.render() is
      // supposed to set this itself, but some builds skip it; setting
      // it explicitly before render() is harmless and defensive.
      textLayer.style.setProperty('--scale-factor', String(targetScale))
      textLayer.style.setProperty('--total-scale-factor', String(targetScale))
      const textContent = await pageObj.getTextContent()
      if (cancelled) return
      type TextLayerCtor = new (opts: {
        textContentSource: unknown
        container: HTMLElement
        viewport: pdfjsLib.PageViewport
      }) => { render(): Promise<void> }
      const lib = pdfjsLib as unknown as { TextLayer?: TextLayerCtor }
      if (lib.TextLayer) {
        const layer = new lib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
        })
        await layer.render()
      }
      if (!cancelled) setRenderTick((t) => t + 1)
    }

    void run()

    return () => {
      cancelled = true
      if (inFlightRef.current.task) {
        try {
          inFlightRef.current.task.cancel()
        } catch {
          /* ignore */
        }
        inFlightRef.current.task = null
      }
    }
  }, [doc, page, scale, fitWidth, containerWidth])

  // Toggle the `.selecting` class on the text-layer during an active
  // drag. pdf.js expands its `endOfContent` marker when this class is
  // present, which lets the browser's selection range stretch past the
  // last visible span on a line / column — without it, selection feels
  // like it "snaps back" when you try to drag through whitespace at
  // the right margin or down to the next paragraph.
  useEffect(() => {
    const layer = textLayerRef.current
    if (!layer) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      layer.classList.add('selecting')
    }
    const onPointerUp = () => layer.classList.remove('selecting')
    layer.addEventListener('pointerdown', onPointerDown)
    // Listen on window so a release outside the layer (drag past the
    // page edge) still clears the class.
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      layer.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  // Paint persisted highlights into a dedicated overlay layer between
  // the canvas and the text-layer. Tinting text-layer spans directly
  // (the previous approach) didn't pop visually because pdf.js sizes
  // its spans to text-content metrics — often narrower than the
  // visible glyph extent on the canvas. An overlay layer renders
  // rectangles at the exact span bounding boxes, so the colored block
  // covers the glyph fully and reads as a real highlighter strike.
  //
  // Strategy:
  //   1. concatenate every span's textContent into one big page
  //      string + a per-span offset index
  //   2. for each highlight, find its passage inside the page string
  //   3. emit one positioned <div> per matching span row, merging
  //      adjacent spans on the same line into a single block so the
  //      highlight reads as a continuous strike rather than a row of
  //      gappy chips.
  useEffect(() => {
    const textLayer = textLayerRef.current
    const overlay = highlightLayerRef.current
    if (!textLayer || !overlay) return
    // Only clear our own highlight markers — leave note markers (a
    // sibling painter) intact. Each painter manages its own elements
    // via a dedicated data attribute.
    overlay.querySelectorAll('[data-notesci-hl]').forEach((el) => el.remove())
    if (highlights.length === 0) return
    const spans = [...textLayer.querySelectorAll('span')] as HTMLSpanElement[]
    if (spans.length === 0) return
    const overlayRect = overlay.getBoundingClientRect()
    // Build a single concatenated page-string with per-span offsets.
    // CRITICAL: insert a single space between spans. pdf.js's text
    // layer puts each visually-separate run in its own <span> without
    // any inter-span character, so a multi-span selection like
    // "Section 1" would land as "Section1" in the concat and fail
    // ``indexOf``. The user-selected text (from window.getSelection())
    // includes the whitespace the browser sees between runs, so the
    // separator-aware concat aligns the two sides.
    let pageText = ''
    const offsets: { span: HTMLSpanElement; start: number; end: number }[] = []
    for (const s of spans) {
      if (pageText.length > 0) pageText += ' '
      const t = s.textContent ?? ''
      offsets.push({ span: s, start: pageText.length, end: pageText.length + t.length })
      pageText += t
    }
    // Whitespace-tolerant search: build a regex that allows any run of
    // whitespace where the saved highlight had any whitespace (single
    // space, newline, tab — selections across pdfjs spans/lines can
    // contain any of these). Escapes regex specials in each token so
    // punctuation in the highlight doesn't blow up.
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const fuzzyFind = (needle: string): [number, number] | null => {
      const trimmed = needle.trim()
      if (!trimmed) return null
      const pattern = trimmed
        .split(/\s+/)
        .map(escape)
        .join('\\s+')
      try {
        const re = new RegExp(pattern, 'i')
        const m = re.exec(pageText)
        return m ? [m.index, m.index + m[0].length] : null
      } catch {
        return null
      }
    }
    const toLocalRect = (r: LocalRect) => {
      const left = Math.max(0, r.left - overlayRect.left)
      const top = Math.max(0, r.top - overlayRect.top)
      const right = Math.min(overlayRect.width, r.right - overlayRect.left)
      const bottom = Math.min(overlayRect.height, r.bottom - overlayRect.top)
      return tightenTextRect({ left, top, right, bottom })
    }
    const groupRectById = new Map<string, LocalRect>()
    const addToGroup = (id: string, r: LocalRect) => {
      const cur = groupRectById.get(id)
      if (cur) {
        cur.left = Math.min(cur.left, r.left)
        cur.top = Math.min(cur.top, r.top)
        cur.right = Math.max(cur.right, r.right)
        cur.bottom = Math.max(cur.bottom, r.bottom)
      } else {
        groupRectById.set(id, { ...r })
      }
    }
    const appendBlock = (
      id: string,
      overlayColor: string,
      r: { left: number; top: number; right: number; bottom: number },
    ) => {
      addToGroup(id, r)
      const wrap = document.createElement('div')
      wrap.dataset.notesciHl = '1'
      wrap.dataset.notesciHlId = id
      wrap.style.position = 'absolute'
      wrap.style.left = `${r.left}px`
      wrap.style.top = `${r.top}px`
      wrap.style.width = `${r.right - r.left}px`
      wrap.style.height = `${r.bottom - r.top}px`
      wrap.style.pointerEvents = 'none'

      const block = document.createElement('div')
      block.style.position = 'absolute'
      block.style.inset = '0'
      block.style.background = overlayColor
      block.style.borderRadius = '2px'
      block.style.pointerEvents = 'none'
      block.style.mixBlendMode = 'multiply'
      wrap.appendChild(block)
      overlay.appendChild(wrap)
    }
    const appendMergedBlocks = (
      id: string,
      overlayColor: string,
      hit: { left: number; top: number; right: number; bottom: number }[],
    ) => {
      if (hit.length === 0) return
      hit.sort((a, b) => a.top - b.top || a.left - b.left)
      const merged: typeof hit = []
      for (const r of hit) {
        const last = merged[merged.length - 1]
        const sameLine =
          last &&
          Math.abs((last.top + last.bottom) / 2 - (r.top + r.bottom) / 2) < 3
        const smallGap = last && r.left <= last.right + 6
        if (sameLine && smallGap) {
          last.left = Math.min(last.left, r.left)
          last.right = Math.max(last.right, r.right)
          last.top = Math.min(last.top, r.top)
          last.bottom = Math.max(last.bottom, r.bottom)
        } else {
          merged.push({ ...r })
        }
      }
      for (const r of merged) appendBlock(id, overlayColor, r)
    }
    const rectsForTextRange = (idx: number, end: number) => {
      const hit: { left: number; top: number; right: number; bottom: number }[] = []
      for (const o of offsets) {
        const start = Math.max(idx, o.start)
        const finish = Math.min(end, o.end)
        if (start >= finish) continue
        const node = [...o.span.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE,
        ) as Text | undefined
        if (!node) {
          const r = toLocalRect(o.span.getBoundingClientRect())
          if (r) hit.push(r)
          continue
        }
        for (const rr of measuredTextNodeRects(node, start - o.start, finish - o.start)) {
          const r = toLocalRect(rr)
          if (r) hit.push(r)
        }
      }
      return hit
    }
    const highlightItems = highlights.map(({ id, text, rects, overlay }) => ({
      id,
      text,
      rects,
      overlay,
    }))
    for (const hl of highlightItems) {
      const { id, text, rects, overlay: overlayColor } = hl
      if (!text) continue
      const savedRects = rects?.filter((r) => r.page === page) ?? []
      if (savedRects.length > 0) {
        for (const r of savedRects) {
          const tight = tightenTextRect({
            left: r.left * overlayRect.width,
            top: r.top * overlayRect.height,
            right: (r.left + r.width) * overlayRect.width,
            bottom: (r.top + r.height) * overlayRect.height,
          })
          if (tight) appendBlock(id, overlayColor, tight)
        }
        continue
      }
      const range = fuzzyFind(text)
      if (!range) continue
      const [idx, end] = range
      appendMergedBlocks(id, overlayColor, rectsForTextRange(idx, end))
    }
    for (const [id, r] of groupRectById) {
      const hit = document.createElement('div')
      hit.dataset.notesciHl = '1'
      hit.dataset.notesciHlGroup = '1'
      hit.dataset.notesciHlId = id
      hit.style.position = 'absolute'
      hit.style.left = `${r.left}px`
      hit.style.top = `${r.top}px`
      hit.style.width = `${r.right - r.left}px`
      hit.style.height = `${r.bottom - r.top}px`
      hit.style.pointerEvents = 'none'
      hit.style.background = 'transparent'
      hit.style.zIndex = '1'
      overlay.appendChild(hit)
    }
  }, [highlights, renderTick, page])

  // Latest-ref so the imperative DOM event handlers above always see
  // the current onDelete callback without re-running the highlight
  // painter on every parent re-render.
  const onDeleteRef = useRef(onDelete)
  useEffect(() => {
    onDeleteRef.current = onDelete
  }, [onDelete])
  const onMoveNoteRef = useRef(onMoveNote)
  useEffect(() => {
    onMoveNoteRef.current = onMoveNote
  }, [onMoveNote])
  const onEditNoteRef = useRef(onEditNote)
  useEffect(() => {
    onEditNoteRef.current = onEditNote
  }, [onEditNote])

  // Sticky-note painter. For each note, find the anchor passage in the
  // page text and place a small yellow sticky-note marker at the
  // RIGHT edge of the line containing the passage (so it lives in the
  // page's right margin like a paper sticky note). Clicking the
  // marker opens an inline card with the note body + delete button.
  useEffect(() => {
    const textLayer = textLayerRef.current
    const overlay = highlightLayerRef.current
    if (!textLayer || !overlay) return
    // Remove previous note markers (they're appended in the same
    // overlay layer alongside highlight blocks; the highlight painter
    // clears the whole overlay first so we don't need to dedupe).
    const existing = overlay.querySelectorAll('[data-notesci-note]')
    existing.forEach((el) => el.remove())
    if (notes.length === 0) return
    const spans = [...textLayer.querySelectorAll('span')] as HTMLSpanElement[]
    if (spans.length === 0) return
    const layerRect = textLayer.getBoundingClientRect()
    const overlayRect = overlay.getBoundingClientRect()
    // Read the current PDF render scale so the marker icon grows / shrinks
    // with the page. pdf.js sets `--scale-factor` on the textLayer during
    // every render; falling back to 1 keeps the baseline identical to the
    // pre-zoom-aware sizing when the variable isn't present.
    const sf =
      parseFloat(
        getComputedStyle(textLayer).getPropertyValue('--scale-factor') || '1',
      ) || 1
    // Clamp so deep zoom-outs stay tap-target sized and extreme zoom-ins
    // don't produce a marker that dominates the page.
    const markerSize = Math.max(14, Math.min(40, Math.round(18 * sf)))
    const markerFont = Math.max(10, Math.min(22, Math.round(11 * sf)))
    let pageText = ''
    const offsets: { span: HTMLSpanElement; start: number; end: number }[] = []
    for (const s of spans) {
      if (pageText.length > 0) pageText += ' '
      const t = s.textContent ?? ''
      offsets.push({ span: s, start: pageText.length, end: pageText.length + t.length })
      pageText += t
    }
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const fuzzyFind = (needle: string): [number, number] | null => {
      const trimmed = needle.trim()
      if (!trimmed) return null
      const pattern = trimmed
        .split(/\s+/)
        .map(escape)
        .join('\\s+')
      try {
        const re = new RegExp(pattern, 'i')
        const m = re.exec(pageText)
        return m ? [m.index, m.index + m[0].length] : null
      } catch {
        return null
      }
    }
    for (const n of notes) {
      // Anchor on the quoted passage when present (notes attached via
      // the selection toolbar are stored as "> passage\n\nbody").
      const quoted = /^>\s*([^\n]+)/.exec(n.text)
      const probe = (quoted?.[1] ?? n.text.split('\n')[0] ?? '').trim()
      const savedRect = n.rects?.find((r) => r.page === page)
      // Find the bounding box of the first span the note touches.
      let firstRect: { top: number; bottom: number; left: number; right: number } | null = null
      if (savedRect) {
        firstRect = {
          top: savedRect.top * overlayRect.height,
          bottom: (savedRect.top + savedRect.height) * overlayRect.height,
          left: savedRect.left * overlayRect.width,
          right: (savedRect.left + savedRect.width) * overlayRect.width,
        }
      } else {
        if (!probe) continue
        const range = fuzzyFind(probe)
        if (!range) continue
        const [idx, end] = range
        for (const o of offsets) {
          if (o.end > idx && o.start < end) {
            const r = o.span.getBoundingClientRect()
            if (r.width === 0 && r.height === 0) continue
            firstRect = {
              top: r.top - layerRect.top,
              bottom: r.bottom - layerRect.top,
              left: r.left - layerRect.left,
              right: r.right - layerRect.left,
            }
            break
          }
        }
      }
      if (!firstRect) continue
      const marker = document.createElement('div')
      marker.dataset.notesciNote = '1'
      marker.style.position = 'absolute'
      // Position: persisted positions are stored as fractions (0..1) of
      // the page viewport so they survive zoom + window-resize re-renders
      // without drifting — the previous absolute-pixel scheme placed the
      // marker at "500 px from the canvas origin", and when the canvas
      // re-rendered narrower after a window switch, the marker stayed
      // pinned to 500 px while the text underneath moved.
      //
      // Legacy entries (pre-2026-05-12) saved as raw pixels are still
      // honored: any value > 1.5 is treated as px and used as-is. The
      // next time the user drags that marker, it's saved as a fraction
      // and becomes scale-invariant from then on.
      const defaultLeft = layerRect.width - (markerSize + 8) // marker + 8px gutter
      const defaultTop = firstRect.top - 2
      let markerLeft = defaultLeft
      let markerTop = defaultTop
      if (n.position) {
        const p = n.position
        const isFraction =
          Math.abs(p.left) <= 1.5 && Math.abs(p.top) <= 1.5
        if (isFraction && layerRect.width > 0 && layerRect.height > 0) {
          markerLeft = p.left * layerRect.width
          markerTop = p.top * layerRect.height
        } else {
          markerLeft = p.left
          markerTop = p.top
          // Auto-upgrade legacy pixel position to a fraction so future
          // re-renders track the page instead of drifting. Deferred via
          // queueMicrotask so the state update doesn't race the current
          // effect's painter run. The next paint sees a fraction and
          // skips this branch.
          if (layerRect.width > 0 && layerRect.height > 0 && onMoveNoteRef.current) {
            const fx = p.left / layerRect.width
            const fy = p.top / layerRect.height
            queueMicrotask(() => {
              onMoveNoteRef.current?.(n.id, { left: fx, top: fy })
            })
          }
        }
      }
      marker.style.left = `${markerLeft}px`
      marker.style.top = `${markerTop}px`
      marker.style.width = `${markerSize}px`
      marker.style.height = `${markerSize}px`
      marker.style.background = '#fff2a8'
      marker.style.border = '1px solid #d6b85a'
      marker.style.borderRadius = `${Math.max(2, Math.round(2 * sf))}px`
      marker.style.color = '#3d2f00'
      marker.style.fontSize = `${markerFont}px`
      marker.style.display = 'inline-flex'
      marker.style.alignItems = 'center'
      marker.style.justifyContent = 'center'
      marker.style.cursor = 'grab'
      marker.style.boxShadow = '0 1px 3px rgba(60,40,0,0.22)'
      marker.style.pointerEvents = 'auto'
      marker.style.zIndex = '5'
      marker.style.touchAction = 'none'
      marker.style.userSelect = 'none'
      marker.textContent = '✎'
      marker.title = `Drag to move · click to open · ${(quoted ? n.text.replace(/^>\s*[^\n]+\n+/, '') : n.text).slice(0, 60)}`
      marker.setAttribute('aria-label', 'Open sticky note')

      // Card revealed on click. Positioned to the LEFT of the marker
      // so it pops out toward the page text. When the marker moves
      // (drag), the card follows alongside it.
      const card = document.createElement('div')
      card.style.position = 'absolute'
      card.style.left = `${markerLeft - 246}px`
      card.style.top = `${markerTop}px`
      card.style.width = '240px'
      card.style.background = '#fff4b8'
      card.style.border = '1px solid #d6b85a'
      card.style.borderRadius = '4px'
      card.style.padding = '10px 12px'
      card.style.fontSize = '12.5px'
      card.style.lineHeight = '1.5'
      card.style.color = '#3d2f00'
      card.style.boxShadow = '0 10px 24px rgba(60,40,0,0.22)'
      card.style.display = 'none'
      card.style.pointerEvents = 'auto'
      card.style.zIndex = '6'
      card.style.whiteSpace = 'pre-wrap'
      card.tabIndex = -1
      card.dataset.notesciNote = '1'
      const body = n.text.replace(/^>\s*[^\n]+\n+/, '').trim() || n.text
      const stopCardEvent = (e: Event) => {
        e.stopPropagation()
      }
      ;['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach((eventName) => {
        card.addEventListener(eventName, stopCardEvent)
      })
      const head = document.createElement('div')
      head.style.display = 'flex'
      head.style.justifyContent = 'space-between'
      head.style.alignItems = 'center'
      head.style.marginBottom = '6px'
      head.style.fontFamily = 'JetBrains Mono, ui-monospace, monospace'
      head.style.fontSize = '9.5px'
      head.style.letterSpacing = '0.1em'
      head.style.textTransform = 'uppercase'
      head.style.color = 'rgba(61,47,0,0.6)'
      const label = document.createElement('span')
      label.textContent = 'Edit note'
      head.appendChild(label)
      if (onDeleteRef.current) {
        const del = document.createElement('button')
        del.type = 'button'
        del.title = 'Delete this note'
        del.setAttribute('aria-label', 'Delete note')
        del.textContent = 'Delete'
        del.style.background = 'rgba(176,58,46,0.10)'
        del.style.border = '1px solid rgba(176,58,46,0.32)'
        del.style.borderRadius = '4px'
        del.style.color = 'rgba(61,47,0,0.65)'
        del.style.fontSize = '11px'
        del.style.cursor = 'pointer'
        del.style.padding = '3px 7px'
        del.style.lineHeight = '1'
        del.addEventListener('pointerdown', stopCardEvent)
        del.addEventListener('mousedown', stopCardEvent)
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          onDeleteRef.current?.(n.id)
        })
        head.appendChild(del)
      }
      card.appendChild(head)
      // Editable body — render as a <textarea> so the user can update
      // the note text in place. Save / Revert / ⌘↩-to-save controls
      // below.
      const bodyEl = document.createElement('textarea')
      bodyEl.value = body
      bodyEl.rows = 5
      bodyEl.setAttribute('aria-label', 'Edit note body')
      bodyEl.style.width = '100%'
      bodyEl.style.minHeight = '80px'
      bodyEl.style.boxSizing = 'border-box'
      bodyEl.style.resize = 'vertical'
      bodyEl.style.background = 'rgba(255,255,255,0.55)'
      bodyEl.style.border = '1px solid rgba(214,184,90,0.6)'
      bodyEl.style.borderRadius = '3px'
      bodyEl.style.padding = '6px 8px'
      bodyEl.style.font = 'inherit'
      bodyEl.style.fontSize = '12.5px'
      bodyEl.style.lineHeight = '1.5'
      bodyEl.style.color = '#3d2f00'
      bodyEl.style.outline = 'none'
      bodyEl.style.whiteSpace = 'pre-wrap'
      card.appendChild(bodyEl)

      // Footer with hint + Revert / Save buttons. Save calls
      // onEditNote(id, body) — the parent persists to localStorage.
      const footer = document.createElement('div')
      footer.style.display = 'flex'
      footer.style.justifyContent = 'space-between'
      footer.style.alignItems = 'center'
      footer.style.marginTop = '8px'
      footer.style.gap = '6px'
      const hint = document.createElement('span')
      hint.textContent = '⌘↩ to save'
      hint.style.fontSize = '10.5px'
      hint.style.color = 'rgba(61,47,0,0.55)'
      footer.appendChild(hint)
      const actions = document.createElement('div')
      actions.style.display = 'flex'
      actions.style.gap = '6px'
      const revertBtn = document.createElement('button')
      revertBtn.type = 'button'
      revertBtn.textContent = 'Revert'
      revertBtn.style.background = 'transparent'
      revertBtn.style.border = '1px solid rgba(214,184,90,0.6)'
      revertBtn.style.borderRadius = '4px'
      revertBtn.style.padding = '4px 8px'
      revertBtn.style.fontSize = '11.5px'
      revertBtn.style.color = 'rgba(61,47,0,0.75)'
      revertBtn.style.cursor = 'not-allowed'
      revertBtn.style.opacity = '0.5'
      revertBtn.disabled = true
      revertBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        bodyEl.value = body
        updateSaveState()
      })
      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.textContent = 'Save'
      saveBtn.setAttribute('aria-label', 'Save note edits')
      saveBtn.style.background = 'rgba(61,47,0,0.3)'
      saveBtn.style.color = '#fff4b8'
      saveBtn.style.border = 'none'
      saveBtn.style.borderRadius = '4px'
      saveBtn.style.padding = '4px 10px'
      saveBtn.style.fontSize = '11.5px'
      saveBtn.style.cursor = 'not-allowed'
      saveBtn.disabled = true
      const updateSaveState = () => {
        const cur = bodyEl.value.trim()
        const dirty = cur.length > 0 && cur !== body.trim()
        saveBtn.disabled = !dirty
        revertBtn.disabled = !dirty
        saveBtn.style.background = dirty ? '#3d2f00' : 'rgba(61,47,0,0.3)'
        saveBtn.style.cursor = dirty ? 'pointer' : 'not-allowed'
        revertBtn.style.opacity = dirty ? '1' : '0.5'
        revertBtn.style.cursor = dirty ? 'pointer' : 'not-allowed'
      }
      const commitSave = () => {
        const next = bodyEl.value.trim()
        if (!next || next === body.trim()) return
        onEditNoteRef.current?.(n.id, next)
      }
      revertBtn.addEventListener('pointerdown', stopCardEvent)
      saveBtn.addEventListener('pointerdown', stopCardEvent)
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        commitSave()
      })
      bodyEl.addEventListener('input', updateSaveState)
      bodyEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          commitSave()
        }
      })
      // Stop bubbling so typing in the textarea doesn't trigger the
      // doc-level click-outside or PDF reader keyboard shortcuts.
      bodyEl.addEventListener('mousedown', (e) => e.stopPropagation())
      bodyEl.addEventListener('click', (e) => e.stopPropagation())
      actions.appendChild(revertBtn)
      actions.appendChild(saveBtn)
      footer.appendChild(actions)
      card.appendChild(footer)

      // Drag to move + click to toggle card. We distinguish the two
      // by tracking how far the pointer moved between mousedown and
      // mouseup — a small movement (< 4px) is a click, anything more
      // is a drag and the click handler should not fire.
      card.dataset.notesciNoteCard = '1'
      let dragging = false
      let downX = 0
      let downY = 0
      let startLeft = 0
      let startTop = 0
      const noteId = n.id
      const onPointerMove = (ev: PointerEvent) => {
        const dx = ev.clientX - downX
        const dy = ev.clientY - downY
        if (!dragging && Math.hypot(dx, dy) < 4) return
        dragging = true
        marker.style.cursor = 'grabbing'
        const overlayRect = overlay.getBoundingClientRect()
        // Clamp inside the overlay bounds so the marker can't be
        // dragged completely off the page.
        const newLeft = Math.max(
          0,
          Math.min(overlayRect.width - markerSize, startLeft + dx),
        )
        const newTop = Math.max(
          0,
          Math.min(overlayRect.height - markerSize, startTop + dy),
        )
        marker.style.left = `${newLeft}px`
        marker.style.top = `${newTop}px`
        // Keep the card glued to the left of the marker so they move
        // together. If the marker is too close to the left edge, flip
        // the card to the right side so it stays on-screen.
        const cardOnRight = newLeft < 250
        card.style.left = cardOnRight
          ? `${newLeft + markerSize + 8}px`
          : `${newLeft - 246}px`
        card.style.top = `${newTop}px`
      }
      const onPointerUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        marker.style.cursor = 'grab'
        if (dragging) {
          // Persist as a FRACTION of the current overlay size so the
          // marker tracks the page at any future zoom / window size.
          // (Absolute pixels would drift after a fit-width re-render.)
          const px = parseFloat(marker.style.left || '0')
          const py = parseFloat(marker.style.top || '0')
          const oR = overlay.getBoundingClientRect()
          const fx = oR.width > 0 ? px / oR.width : 0
          const fy = oR.height > 0 ? py / oR.height : 0
          onMoveNoteRef.current?.(noteId, { left: fx, top: fy })
          // Suppress the synthesized click that would otherwise fire
          // after pointerup at the same position.
          const stopClick = (e: MouseEvent) => {
            e.stopPropagation()
            e.preventDefault()
            window.removeEventListener('click', stopClick, true)
          }
          window.addEventListener('click', stopClick, true)
          ev.preventDefault()
        }
        dragging = false
      }
      marker.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return
        ev.preventDefault()
        document
          .querySelectorAll('.textLayer.selecting')
          .forEach((node) => node.classList.remove('selecting'))
        downX = ev.clientX
        downY = ev.clientY
        startLeft = parseFloat(marker.style.left || '0')
        startTop = parseFloat(marker.style.top || '0')
        dragging = false
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
      })
      marker.addEventListener('click', (e) => {
        if (dragging) return
        e.stopPropagation()
        const opening = card.style.display !== 'block'
        // Close any other open sticky cards first.
        overlay
          .querySelectorAll('[data-notesci-note-card]')
          .forEach((el) => {
            ;(el as HTMLElement).style.display = 'none'
          })
        // Close any open highlight popovers too.
        overlay
          .querySelectorAll('[data-notesci-popover]')
          .forEach((el) => el.remove())
        card.style.display = opening ? 'block' : 'none'
        if (opening) {
          window.setTimeout(() => bodyEl.focus(), 0)
        }
      })

      overlay.appendChild(marker)
      overlay.appendChild(card)
    }
  }, [notes, renderTick, page])

  // Hover-visible × badge for highlights. Old behaviour: click a
  // highlight → popover with "× Delete highlight" appeared, which
  // worked but was undiscoverable. New behaviour: when the pointer is
  // over a highlight, a small × button appears at its top-right. One
  // click deletes the highlight outright. The badge sits at a higher
  // z-index than the text-layer (z-index 2) so it intercepts the
  // click before the text-layer can spawn a fresh selection.
  useEffect(() => {
    const overlay = highlightLayerRef.current
    if (!overlay) return
    let currentId: string | null = null
    let badge: HTMLButtonElement | null = null
    const removeBadge = () => {
      currentId = null
      if (badge) {
        badge.remove()
        badge = null
      }
    }
    const findHover = (clientX: number, clientY: number): {
      id: string
      rect: DOMRect
    } | null => {
      const wraps = overlay.querySelectorAll(
        '[data-notesci-hl-id]:not([data-notesci-hl-group])',
      ) as NodeListOf<HTMLElement>
      const groups = overlay.querySelectorAll(
        '[data-notesci-hl-group]',
      ) as NodeListOf<HTMLElement>
      for (const wrap of wraps) {
        const r = wrap.getBoundingClientRect()
        if (
          clientX >= r.left &&
          clientX <= r.right &&
          clientY >= r.top &&
          clientY <= r.bottom
        ) {
          const id = wrap.dataset.notesciHlId
          const group = id
            ? [...groups].find((el) => el.dataset.notesciHlId === id)
            : null
          if (id) return { id, rect: group?.getBoundingClientRect() ?? r }
        }
      }
      return null
    }
    const onMove = (e: MouseEvent) => {
      // Don't show the badge while the user is drag-selecting — it
      // would intercept clicks meant to end the selection. Two
      // checks: an active multi-char selection (toString().trim()),
      // and the per-page `.selecting` class which is set on
      // pointerdown so we also catch the first few pixels of a drag
      // where no characters are selected yet.
      if (
        window.getSelection?.()?.toString().trim() ||
        document.querySelector('.textLayer.selecting')
      ) {
        if (badge) removeBadge()
        return
      }
      // If the pointer is on the badge itself, leave it alone.
      const t = e.target as Element | null
      if (t?.closest?.('[data-notesci-hl-badge]')) return
      const hit = findHover(e.clientX, e.clientY)
      if (!hit) {
        if (badge) removeBadge()
        return
      }
      if (hit.id === currentId && badge) return
      removeBadge()
      currentId = hit.id
      const layerRect = overlay.getBoundingClientRect()
      const el = document.createElement('button')
      el.type = 'button'
      el.dataset.notesciHlBadge = '1'
      el.setAttribute('aria-label', 'Delete highlight')
      el.title = 'Delete highlight'
      el.textContent = '×'
      el.style.position = 'absolute'
      // Anchor at the top-right corner, slightly inset so it overlaps
      // the highlight band a touch — reads as "attached to this band".
      el.style.left = `${hit.rect.right - layerRect.left - 10}px`
      el.style.top = `${hit.rect.top - layerRect.top - 10}px`
      el.style.width = '20px'
      el.style.height = '20px'
      el.style.padding = '0'
      el.style.display = 'inline-flex'
      el.style.alignItems = 'center'
      el.style.justifyContent = 'center'
      el.style.background = 'var(--color-ink)'
      el.style.color = '#fff'
      el.style.border = '2px solid var(--color-paper)'
      el.style.borderRadius = '999px'
      el.style.boxShadow = '0 2px 6px rgba(14,17,22,0.28)'
      el.style.cursor = 'pointer'
      el.style.fontFamily = 'inherit'
      el.style.fontSize = '14px'
      el.style.lineHeight = '1'
      el.style.zIndex = '7'
      el.style.pointerEvents = 'auto'
      el.style.transition = 'transform 120ms ease, background 120ms ease'
      el.addEventListener('mouseenter', () => {
        el.style.transform = 'scale(1.12)'
        el.style.background = 'var(--color-error, #b03a2e)'
      })
      el.addEventListener('mouseleave', () => {
        el.style.transform = 'scale(1)'
        el.style.background = 'var(--color-ink)'
      })
      const stopBadgePointer = (ev: Event) => {
        // Stop the text-layer from clearing the selection / treating
        // this as a fresh click on the page beneath.
        ev.preventDefault()
        ev.stopPropagation()
        document
          .querySelectorAll('.textLayer.selecting')
          .forEach((node) => node.classList.remove('selecting'))
      }
      el.addEventListener('pointerdown', stopBadgePointer)
      el.addEventListener('mousedown', stopBadgePointer)
      el.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        const id = currentId
        removeBadge()
        if (id) onDeleteRef.current?.(id)
      })
      badge = el
      overlay.appendChild(el)
    }
    const onLeave = (e: MouseEvent) => {
      // Only hide when the cursor truly leaves both the highlight
      // wrap AND the badge itself.
      const t = e.relatedTarget as Element | null
      if (t?.closest?.('[data-notesci-hl-badge]')) return
      const hit = findHover(e.clientX, e.clientY)
      if (!hit) removeBadge()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      removeBadge()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  // Layer-level click-outside handler. Any click on the overlay layer
  // (or anywhere in the document) that isn't on a popover element
  // closes all popovers / open sticky-note cards. Without this, the
  // user has no way to dismiss the popover except by clicking the
  // delete button.
  useEffect(() => {
    const overlay = highlightLayerRef.current
    if (!overlay) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Element | null
      // Keep open if user clicked on a popover / card / marker.
      if (!t) return
      if (
        t.closest?.('[data-notesci-popover]') ||
        t.closest?.('[data-notesci-hl-badge]') ||
        t.closest?.('[data-notesci-note-card]') ||
        t.closest?.('[data-notesci-note]')
      ) {
        return
      }
      overlay
        .querySelectorAll('[data-notesci-popover]')
        .forEach((el) => el.remove())
      overlay
        .querySelectorAll('[data-notesci-note-card]')
        .forEach((el) => {
          ;(el as HTMLElement).style.display = 'none'
        })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        overlay
          .querySelectorAll('[data-notesci-popover]')
          .forEach((el) => el.remove())
        overlay
          .querySelectorAll('[data-notesci-note-card]')
          .forEach((el) => {
            ;(el as HTMLElement).style.display = 'none'
          })
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  // While the backdrop is showing (renderTick === 0), pin the wrapper
  // to the snapshot's dimensions so the surrounding flex layout
  // doesn't collapse to 0 height for the brief instant before the
  // canvas is sized. Once the canvas paints (renderTick > 0), revert
  // to natural sizing so future zoom / page changes can resize freely.
  const wrapMinWidth =
    snapshot && renderTick === 0 ? snapshot.cssWidth : undefined
  const wrapMinHeight =
    snapshot && renderTick === 0 ? snapshot.cssHeight : undefined
  // Compose the local container ref with the optional `registerRef`
  // callback from the parent (used in continuous mode for scroll-to-page
  // and IntersectionObserver-based "which page is on screen?" tracking).
  const setContainerRef = (el: HTMLDivElement | null) => {
    containerRef.current = el
    registerRef?.(page, el)
  }
  return (
    <div
      ref={setContainerRef}
      data-page={page}
      data-notesci-page="1"
      style={{
        position: 'relative',
        boxShadow: '0 4px 18px rgba(0,0,0,0.10)',
        background: '#fff',
        minWidth: wrapMinWidth,
        minHeight: wrapMinHeight,
        // `flex-shrink: 0` is critical — without it, the flex parent
        // squashes the page down to fit when the viewport is narrower
        // than the canvas, which hides the right side AND breaks the
        // scroll-to-left-edge fix. With `0`, the page stays at its
        // intrinsic canvas width and the parent's overflow-x kicks in.
        flexShrink: 0,
        // Add a content-visibility hint for pages far off-screen — the
        // browser skips paint / layout work on them until they scroll
        // close to the viewport. Falls back to normal rendering on
        // engines that don't recognise the property. Gives a big win
        // on 100+ page PDFs without us having to hand-roll windowing.
        // `contain-intrinsic-size` reserves space at the canvas's
        // expected dimensions so the scroll position stays stable when
        // off-screen pages get virtualised.
        contentVisibility: 'auto',
        containIntrinsicSize: '800px 1035px',
      }}
    >
      {/* Snapshot backdrop: rendered ONLY before the fresh canvas
          paint has completed (renderTick === 0). The image carries the
          previous render's pixels at the previous CSS dimensions so
          the user sees the same content instead of a blank white area
          while pdf.js redraws. The fresh canvas sits above it
          (z-index unset; document order wins) and replaces it once
          painted. After the first successful render, renderTick > 0
          and the backdrop unmounts.
          The wrapper has its width/height pinned so the surrounding
          flex layout sizes the page correctly even before the canvas
          has its own dimensions. */}
      {snapshot && renderTick === 0 && (
        <img
          src={snapshot.dataUrl}
          aria-hidden
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: `${snapshot.cssWidth}px`,
            height: `${snapshot.cssHeight}px`,
            display: 'block',
            pointerEvents: 'none',
            zIndex: 0,
            // No transition: the canvas paint underneath should drop
            // in cleanly. A fade would just smear the swap visually.
          }}
        />
      )}
      <canvas ref={canvasRef} style={{ display: 'block', position: 'relative', zIndex: 1 }} />
      {/* Highlight overlay layer — sits BETWEEN the canvas and the
          text-layer so the colored blocks paint visibly over the page
          but never block the user's drag-select on the spans above
          (pointer-events: none on the layer + each block). The blocks
          are absolutely positioned at the exact span bounding boxes
          and grouped per-line so a multi-word highlight reads as one
          continuous bar instead of a gappy row of chips. */}
      <div
        ref={highlightLayerRef}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          // Sit ABOVE the text-layer (z-index 2) so the sticky-note
          // marker, the expanded card, and the highlight popovers can
          // all receive pointer events. The layer itself stays
          // `pointer-events: none` so the text-layer beneath still
          // owns drag-select on the spans — only the specific
          // interactive children (markers / cards / popovers / delete
          // buttons) opt back into pointer events.
          zIndex: 3,
          pointerEvents: 'none',
        }}
      />
      {/* pdf.js v5 text layer. Sized to match the canvas viewport, with
          spans absolutely positioned by pdf.js. Real styles (transparent
          text, absolute spans, cursor, selection highlight) live in
          index.css under `.textLayer` — pdf.js requires that exact
          class name on the container and on spans, so we keep the CSS
          global and let it own all positioning / cursor / z-index
          rules. Keeping inline styles minimal also avoids fighting the
          `.textLayer.selecting .endOfContent { top: 0 }` selector that
          makes drag-select extend past the last span on a line. */}
      <div ref={textLayerRef} className="textLayer" />
      {/* Custom pixel-tight selection overlay. Painted from measured
          text-node character edges — see the selectionchange handler.
          Sits above the textLayer so the halo reads, but pointer-events:
          none so it doesn't intercept the user's drag-select. */}
      <div
        ref={selectionLayerRef}
        className="ns-pdf-selection-layer"
        aria-hidden
      />
      {/* Small page-number badge in the top-left corner. Visible only
          in continuous mode (where multiple pages stack and the
          toolbar indicator alone isn't enough to orient mid-scroll).
          Positioned outside the canvas via a negative offset so it
          doesn't cover document text; styled like a tiny tag. */}
      {pageLabel && (
        <div
          aria-hidden
          className="font-mono"
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            zIndex: 4,
            fontSize: 10,
            letterSpacing: '0.06em',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'color-mix(in oklch, var(--color-ink) 78%, transparent)',
            color: 'var(--color-paper)',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {pageLabel}
        </div>
      )}
    </div>
  )
}
