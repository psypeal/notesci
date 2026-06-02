import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '../icons'
import { api, apiBlob } from '../../lib/api'
import { useToast } from '../Toast'
import { relativeTime as fmtRelative } from '../../lib/relative-time'
import { isSafeHttpUrl } from '../../lib/redirect'
import { openInSystemBrowser } from '../../lib/tauri'
import type { PdfSelectionRect } from './PdfReader'

// pdfjs-dist is ~1 MB raw, ~250 KB gzipped — lazy-load it so it only
// downloads when the user actually opens a PDF material. We capture
// the module reference so `invalidateMaterialCache` below can drop
// the cached parsed PDF doc when the source material is deleted; if
// the chunk hasn't been loaded yet, the ref stays null and there's
// nothing to invalidate.
type PdfReaderModule = typeof import('./PdfReader')
let pdfReaderModule: PdfReaderModule | null = null
const PdfReader = lazy(() =>
  import('./PdfReader').then((m) => {
    pdfReaderModule = m
    return { default: m.PdfReader }
  }),
)

interface MaterialDetail {
  id: string
  title: string | null
  source_type: string
  uri: string | null
  metadata: Record<string, unknown>
  created_at: string
}

/**
 * Module-level caches for material metadata, PDF bytes, and stitched
 * content text. ReaderPane unmounts on every layout switch, so without
 * a cache each re-entry triggers a full materials-list fetch + raw-bytes
 * download + pdf.js parse — which is what produced the multi-second
 * blank "Loading PDF…" the user experienced as "disconnect".
 *
 * Cache shape:
 *   - `metaCache`   keyed by material_id (cheap JSON, never evicted)
 *   - `blobCache`   keyed by material_id, capped at MAX_BLOB_CACHE
 *                   to avoid pinning a workspace's worth of MB-sized
 *                   PDFs in memory
 *   - `contentCache` keyed by material_id (chunks-text, cheap)
 *
 * Insertions push the key to the back of an LRU queue; reads bring
 * the key to the back. When the blob cache exceeds the cap, the
 * head (least-recently used) is dropped. Deletes (e.g. user removes
 * a material) call `invalidateMaterialCache` to drop all three
 * entries at once.
 */
const MAX_BLOB_CACHE = 8
const metaCache = new Map<string, MaterialDetail>()
const blobCache = new Map<string, Blob>()
const contentCache = new Map<string, string>()
const blobLru: string[] = []
function touchBlobLru(id: string) {
  const i = blobLru.indexOf(id)
  if (i >= 0) blobLru.splice(i, 1)
  blobLru.push(id)
  while (blobLru.length > MAX_BLOB_CACHE) {
    const drop = blobLru.shift()
    if (drop) blobCache.delete(drop)
  }
}
// Exported for callers that delete materials — keeps stale bytes
// from being served to the reader after the row is gone.
export function invalidateMaterialCache(id: string) {
  const blob = blobCache.get(id)
  metaCache.delete(id)
  blobCache.delete(id)
  contentCache.delete(id)
  const i = blobLru.indexOf(id)
  if (i >= 0) blobLru.splice(i, 1)
  // Drop the parsed pdf.js doc tied to this blob so a future re-upload
  // with the same id doesn't render stale bytes. Safe when the chunk
  // hasn't been loaded yet (the pdfReaderModule ref stays null).
  if (blob) pdfReaderModule?.invalidateDocByBlob(blob)
}

/** Wipe every cached material — invoked from `signOut()` so the next
 *  user on this browser can't see the previous user's documents in the
 *  reader chrome (title, blob, stitched text). Also cascades into the
 *  PdfReader cache when that chunk has been loaded, so the parsed
 *  pdf.js doc and its blob URL are torn down at the same time. */
export function clearReaderCaches() {
  metaCache.clear()
  blobCache.clear()
  contentCache.clear()
  blobLru.length = 0
  pdfReaderModule?.clearPdfCaches()
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

/** Highlight palette — the 5 cards that pop up when the user clicks
 *  "Highlight" on the floating selection toolbar. Each entry pairs a
 *  short slug (persisted on the annotation) with the visible swatch
 *  color used to render the card AND to tint the saved highlight when
 *  it's re-rendered as an overlay over the PDF text. The overlay
 *  alphas are intentionally higher (~0.7) than typical text-tint
 *  values — pdf.js spans are sometimes narrower than the visible
 *  canvas glyph, and a soft tint at 0.4 disappears against grayscale
 *  body text. The brighter overlay makes the highlight unambiguous. */
const HIGHLIGHT_COLORS = [
  { id: 'yellow', label: 'Yellow', swatch: '#ffe66f', overlay: 'rgba(255, 226, 90, 0.46)' },
  { id: 'green', label: 'Green', swatch: '#b5e8a4', overlay: 'rgba(154, 230, 140, 0.40)' },
  { id: 'blue', label: 'Blue', swatch: '#a3d4ff', overlay: 'rgba(140, 200, 255, 0.42)' },
  { id: 'pink', label: 'Pink', swatch: '#ffb3d1', overlay: 'rgba(255, 160, 200, 0.40)' },
  { id: 'indigo', label: 'Indigo', swatch: '#c5b8ff', overlay: 'rgba(186, 170, 255, 0.38)' },
] as const
type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]['id']

const RAW_LINK_RE =
  /\b(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g

function normalizeUrlToken(rawUrl: string): string {
  return rawUrl.trim().replace(/[)\].,:!?;]+$/g, '')
}

function resolveSafeHttpHref(rawUrl: string): string | null {
  const normalized = normalizeUrlToken(rawUrl)
  const href = normalized.startsWith('www.') ? `https://${normalized}` : normalized
  return isSafeHttpUrl(href) ? href : null
}

function splitTextWithLinks(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let i = 0
  const re = new RegExp(RAW_LINK_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      out.push(<span key={`${keyBase}-t${i++}`}>{text.slice(last, match.index)}</span>)
    }
    const raw = match[0]
    const href = resolveSafeHttpHref(raw)
    out.push(
      href ? (
        <a
          key={`${keyBase}-u${i++}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault()
            openInSystemBrowser(href)
          }}
        >
          {raw}
        </a>
      ) : (
        <span key={`${keyBase}-u${i++}`}>{raw}</span>
      ),
    )
    last = match.index + raw.length
  }
  if (last < text.length) {
    out.push(<span key={`${keyBase}-t${i++}`}>{text.slice(last)}</span>)
  }
  return out
}

/** Hoisted color-by-id lookup so the highlights-for-reader useMemo
 *  doesn't scan the palette array on every annotation. With dozens of
 *  highlights per material the linear scan added up. */
const COLOR_BY_ID: Record<string, (typeof HIGHLIGHT_COLORS)[number]> =
  Object.fromEntries(HIGHLIGHT_COLORS.map((c) => [c.id, c]))

interface Annotation {
  id: string
  materialId: string
  kind: 'highlight' | 'note'
  text: string
  /** Exact PDF selection geometry, stored as page-local fractions so new
   *  highlights/notes repaint the same visual area across zoom and
   *  fit-width reflows. Older text-only annotations omit this and fall
   *  back to text matching in PdfReader. */
  pdfRects?: PdfSelectionRect[]
  /** For highlights, the color the user picked. Older annotations
   *  written before the color picker existed have no `color` field —
   *  render those as yellow (the most common default). */
  color?: HighlightColor
  /** For notes, the dragged position of the sticky-note marker on the
   *  page, expressed as canvas-relative {left, top} in CSS pixels.
   *  Absent until the user moves the note — the default position is
   *  the right margin of the line the note is anchored to. */
  position?: { left: number; top: number }
  createdAt: number
}

/** Build the workspace-scoped annotations key. We used to write to a
 *  single global `notesci_annotations` key, which leaked another user's
 *  highlights into the reader when two accounts shared a browser —
 *  scoping by workspace_id fixes that. The migration in
 *  `loadAnnotations` moves existing entries forward on first read.
 *
 *  The legacy key is read once (and only once) per workspace for
 *  migration. Callers MUST pass a real workspace id to
 *  load/save — see the null guards below — otherwise we'd briefly
 *  surface the previous user's highlights during the `/me`
 *  round-trip window. */
const LEGACY_ANNOT_KEY = 'notesci_annotations'
function annotKey(workspaceId: string): string {
  return `notesci_annotations_${workspaceId}`
}

function loadAnnotations(workspaceId: string | null): Annotation[] {
  // Null workspace = `/me` still in flight. Return empty rather than
  // falling back to the legacy global key — otherwise the previous
  // user's pre-migration annotations briefly surface in the reader
  // for the duration of the round-trip.
  if (!workspaceId) return []
  try {
    const key = annotKey(workspaceId)
    let raw = localStorage.getItem(key)
    // First-read migration: if the workspace-scoped key is empty but
    // the legacy global key has entries, move them over. Safe to run
    // every load — once the legacy key is removed below, subsequent
    // calls take the fast path. Only runs once we know the workspace
    // id (the null guard above).
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_ANNOT_KEY)
      if (legacy) {
        try {
          localStorage.setItem(key, legacy)
          localStorage.removeItem(LEGACY_ANNOT_KEY)
          raw = legacy
        } catch {
          /* private mode / quota — fall through to the legacy parse */
          raw = legacy
        }
      }
    }
    return raw ? (JSON.parse(raw) as Annotation[]) : []
  } catch {
    return []
  }
}

function saveAnnotations(workspaceId: string | null, items: Annotation[]) {
  // Null workspace = `/me` in flight. Skip the write so we don't touch
  // the legacy key (which would re-introduce the cross-user leak the
  // workspace-scoped keys were designed to prevent).
  if (!workspaceId) return
  try {
    localStorage.setItem(annotKey(workspaceId), JSON.stringify(items))
  } catch {
    /* quota / private mode — annotations stay in memory for this session */
  }
}

/**
 * Reader pane — the design's PDF / source reading view. Mirrors
 * `ReaderPane` in `ws-panes.jsx`.
 *
 * In dev we show one of the project's materials with a sample
 * highlighted-passage layout. The real backend doesn't yet expose a
 * "fetch the original bytes / paginate the PDF" endpoint, so the body
 * is rendered as the metadata + a placeholder excerpt.
 */
export function ReaderPane({
  projectId,
  workspaceId,
  materialId,
  onAskAboutPassage,
  citationTarget,
}: {
  projectId: string
  /** Current workspace id — used to scope annotations to this
   *  workspace so two accounts sharing a browser don't see each other's
   *  highlights. May be null on the very first render before `/me`
   *  resolves; falls back to the legacy global key for that frame
   *  (migration runs the moment the workspace id lands). */
  workspaceId: string | null
  materialId: string | null
  /** Called with a fully-formed question when the user clicks "Ask about this passage". */
  onAskAboutPassage?: (question: string) => void
  /** Set by the host when the user clicked an in-chat citation. The
   *  pane pulses a halo so the jump is visible, and (Slice C) will
   *  use chunk text to scroll the PDF reader to the cited passage.
   *  ``nonce`` lets the host re-trigger on repeat clicks. */
  citationTarget?: {
    materialId: string
    chunkId: number
    nonce: number
  } | null
}) {
  const [material, setMaterial] = useState<MaterialDetail | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>(() =>
    loadAnnotations(workspaceId),
  )
  // When the workspaceId arrives after the initial render (because
  // `/me` is still in flight), re-pull annotations so the user sees
  // their migrated set rather than the empty legacy view.
  useEffect(() => {
    setAnnotations(loadAnnotations(workspaceId))
  }, [workspaceId])
  // Pulse-on-citation: when the host bumps citationTarget.nonce, set
  // [data-reader-pulse] on the pane for one second so the user sees
  // the pane react to the chip click. CSS keyframe handles the fade.
  const [pulseKey, setPulseKey] = useState(0)
  useEffect(() => {
    if (!citationTarget) return
    setPulseKey((k) => k + 1)
    const t = setTimeout(() => setPulseKey(0), 1300)
    return () => clearTimeout(t)
  }, [citationTarget?.nonce, citationTarget?.materialId])
  const toast = useToast()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Stable PDF error handler. A fresh arrow function each render would
  // make PdfReader see "new props" on every ReaderPane update, which
  // (via its load effect) would destroy and reload the PDF doc — that's
  // what produced the heavy flicker during text drag-select.
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  }, [toast])
  const onPdfError = useCallback((msg: string) => {
    toastRef.current.error(`PDF render failed: ${msg}`)
  }, [])

  // Live selection state — drives the floating selection toolbar.
  // Updated on `selectionchange` so the toolbar appears as soon as the
  // user finishes a drag-select inside the reader body and disappears
  // when the selection collapses.
  const [selection, setSelection] = useState<{
    text: string
    rect: { top: number; left: number; right: number; bottom: number }
    pdfRects?: PdfSelectionRect[]
  } | null>(null)
  // Inline note editor state — shown anchored near the selection when
  // the user clicks "Note" on the floating toolbar. No modal; it's a
  // small popover that lives in the document body via portal.
  const [noteDraft, setNoteDraft] = useState<{
    seed: string
    rect: { top: number; left: number; right: number; bottom: number }
    text: string
    pdfRects?: PdfSelectionRect[]
  } | null>(null)

  const readPdfSelectionRects = (range: Range): PdfSelectionRect[] => {
    const root = bodyRef.current
    if (!root) return []
    const pages = [...root.querySelectorAll<HTMLElement>('[data-notesci-page]')]
      .map((el) => ({
        el,
        page: Number(el.dataset.page),
        rect: el.getBoundingClientRect(),
      }))
      .filter(({ page, rect }) => Number.isFinite(page) && rect.width > 0 && rect.height > 0)
    if (pages.length === 0) return []

    const out: PdfSelectionRect[] = []
    for (const p of pages) {
      const textLayer = p.el.querySelector<HTMLElement>('.textLayer')
      if (!textLayer) continue
      for (const raw of textNodeSelectionRects(range, textLayer)) {
        if (raw.right - raw.left < 0.5 || raw.bottom - raw.top < 0.5) continue
        const left = Math.max(raw.left, p.rect.left)
        const top = Math.max(raw.top, p.rect.top)
        const right = Math.min(raw.right, p.rect.right)
        const bottom = Math.min(raw.bottom, p.rect.bottom)
        const width = right - left
        const height = bottom - top
        if (width < 0.5 || height < 0.5) continue
        out.push({
          page: p.page,
          left: (left - p.rect.left) / p.rect.width,
          top: (top - p.rect.top) / p.rect.height,
          width: width / p.rect.width,
          height: height / p.rect.height,
        })
      }
    }
    return out
  }

  // Read the current text selection if it lives inside the reader body
  // and return both the text and its viewport-anchored bounding rect.
  // Returns null when the selection is empty, collapsed, or outside the
  // reader (e.g. user selected text in the sidebar).
  const readBodySelection = (): {
    text: string
    rect: { top: number; left: number; right: number; bottom: number }
    pdfRects?: PdfSelectionRect[]
  } | null => {
    if (typeof window === 'undefined') return null
    const sel = window.getSelection?.()
    if (!sel || sel.rangeCount === 0) return null
    const text = sel.toString().trim()
    if (!text) return null
    const range = sel.getRangeAt(0)
    const container = range.commonAncestorContainer
    if (!bodyRef.current?.contains(container as Node)) return null
    const r = range.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return {
      text,
      rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
      pdfRects: readPdfSelectionRects(range),
    }
  }

  // Native browser text-selection drives the floating toolbar.
  //
  // Why this shape: pdf.js v5's TextLayer renders glyph-aligned spans
  // (font-kerning: none, geometric precision) so the browser's own
  // character-level hit-testing IS per-glyph precise. We just have to
  // read the selection at the right moment.
  //
  // We listen on `pointerup` and `keyup` (for shift-arrow extensions)
  // — NOT `selectionchange`. `selectionchange` fires dozens of times
  // per second during a drag; settling on the gesture boundary keeps
  // the toolbar from re-rendering every frame, which is what made the
  // old native-selection path feel flickery.
  //
  // requestAnimationFrame defers the read by one frame so the browser
  // has finalised the range before we sample it.
  useEffect(() => {
    let rafId: number | null = null
    const settle = () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        const next = readBodySelection()
        // Only setState when the text actually changed — avoids a
        // re-render on every pointerup that just collapsed the caret
        // somewhere outside the reader.
        setSelection((prev) => {
          if (prev?.text === next?.text && prev?.rect.top === next?.rect.top) {
            return prev
          }
          return next
        })
      })
    }
    const onPointerUp = () => settle()
    const onKeyUp = (e: KeyboardEvent) => {
      // Settle on releases that ended a selection extension. Catch
      // both the shift-key release (extends/shrinks selection) and
      // arrow-key releases while shift is held.
      if (
        e.key === 'Shift' ||
        e.shiftKey ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        settle()
      }
    }
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Click-outside dismissal. If the floating toolbar is showing, a
  // click that isn't on the toolbar itself or on the reader body
  // collapses the selection and hides the toolbar.
  useEffect(() => {
    if (!selection) return
    const onPointerDown = (e: PointerEvent) => {
      if (noteDraft) return
      const t = e.target as Element | null
      if (t?.closest?.('[data-notesci-sel-toolbar]')) return
      // A click that lands inside the reader will be followed by a
      // pointerup that re-samples the selection via the settle()
      // path above. Don't pre-emptively clear here — that creates an
      // intermediate "toolbar disappears then reappears" flicker.
      if (t?.closest?.('[data-notesci-page]')) return
      setSelection(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [selection, noteDraft])

  const ownAnnotations = useMemo(
    () =>
      materialId
        ? annotations
            .filter((a) => a.materialId === materialId)
            .sort((a, b) => b.createdAt - a.createdAt)
        : [],
    [annotations, materialId],
  )

  // Pre-shaped highlight + note arrays for PdfReader / TextHighlighted.
  // CRITICAL: these MUST be referentially stable across re-renders. The
  // PDF reader's highlights + notes painter effects depend on these
  // arrays — a fresh array reference on every parent re-render (e.g.
  // user dismissing the email-verify banner, which re-renders Workspace
  // and cascades through ReaderPane) would tear down every marker and
  // recreate it, producing the "heavy flicker" the user reported. With
  // useMemo gated on `ownAnnotations`, the arrays only change identity
  // when an annotation is actually added / removed / moved / edited.
  const highlightsForReader = useMemo(
    () =>
      ownAnnotations
        .filter((a) => a.kind === 'highlight')
        .map((a) => ({
          id: a.id,
          text: a.text,
          rects: a.pdfRects,
          overlay:
            (a.color && COLOR_BY_ID[a.color]?.overlay) ??
            HIGHLIGHT_COLORS[0].overlay,
        })),
    [ownAnnotations],
  )
  const notesForReader = useMemo(
    () =>
      ownAnnotations
        .filter((a) => a.kind === 'note')
        .map((a) => ({
          id: a.id,
          text: a.text,
          rects: a.pdfRects,
          position: a.position,
        })),
    [ownAnnotations],
  )

  const persistAnnotation = (
    kind: 'highlight' | 'note',
    text: string,
    color?: HighlightColor,
    pdfRects?: PdfSelectionRect[],
  ) => {
    if (!materialId) return false
    // Collapse runs of whitespace (including the \n a cross-line drag-
    // select picks up) into single spaces before persisting. The PDF
    // highlight painter does whitespace-tolerant matching, but
    // normalised storage keeps the saved value readable in the
    // annotations sidebar and avoids leading-newline weirdness when
    // the user re-opens a note.
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (!trimmed) return false
    const next: Annotation = {
      id: crypto.randomUUID(),
      materialId,
      kind,
      text: trimmed,
      ...(pdfRects?.length ? { pdfRects } : {}),
      ...(color ? { color } : {}),
      createdAt: Date.now(),
    }
    const updated = [next, ...annotations]
    setAnnotations(updated)
    saveAnnotations(workspaceId, updated)
    toast.success(kind === 'highlight' ? 'Passage highlighted.' : 'Note saved.')
    return true
  }

  // Toolbar Highlight: now takes a color picked from the inline color
  // cards (yellow / green / blue / pink / indigo). The toolbar
  // expands to the card row when the user clicks "Highlight"; clicking
  // a card persists the annotation with that color and closes the
  // toolbar. No modal popup at any point.
  const highlightFromSelection = (color: HighlightColor) => {
    const sel = selection ?? readBodySelection()
    if (!sel) {
      toast.toast('Select text in the reader first.')
      return
    }
    if (persistAnnotation('highlight', sel.text, color, sel.pdfRects)) {
      window.getSelection()?.removeAllRanges()
      setSelection(null)
    }
  }
  // Toolbar Note: open the inline note editor anchored at the
  // selection (or at the toolbar if no selection). Pre-fills the
  // textarea with the selected passage so the user can write a note
  // about that specific text.
  const openNoteEditor = (anchorRect?: {
    top: number
    left: number
    right: number
    bottom: number
  }) => {
    const sel = selection ?? readBodySelection()
    const rect =
      sel?.rect ??
      anchorRect ??
      (() => {
        const b = bodyRef.current?.getBoundingClientRect()
        return {
          top: (b?.top ?? 100) + 40,
          left: (b?.left ?? 100) + 40,
          right: (b?.left ?? 100) + 240,
          bottom: (b?.top ?? 100) + 60,
        }
      })()
    setNoteDraft({ seed: sel?.text ?? '', rect, text: '', pdfRects: sel?.pdfRects })
  }

  const deleteAnnotation = (id: string) => {
    const target = annotations.find((a) => a.id === id)
    const updated = annotations.filter((a) => a.id !== id)
    setAnnotations(updated)
    saveAnnotations(workspaceId, updated)
    if (target) toast.toast(`${target.kind === 'highlight' ? 'Highlight' : 'Note'} removed.`)
  }

  // Persist the dragged position of a sticky note so it stays where
  // the user dropped it across re-renders and reloads. Coordinates
  // are in canvas-local CSS pixels (the same coord space the notes
  // painter uses to compute the default right-margin position).
  const moveAnnotation = (id: string, position: { left: number; top: number }) => {
    const updated = annotations.map((a) =>
      a.id === id ? { ...a, position } : a,
    )
    setAnnotations(updated)
    saveAnnotations(workspaceId, updated)
  }

  // Persist an edit to a sticky-note body. The leading "> quoted
  // passage\n\n" header (when present) is preserved so the note stays
  // anchored to its source passage; only the body after the header is
  // replaced with the new text.
  const editAnnotation = (id: string, newText: string) => {
    const trimmed = newText.trim()
    if (!trimmed) return
    const updated = annotations.map((a) => {
      if (a.id !== id) return a
      const quoted = /^>\s*[^\n]+\n+/.exec(a.text)
      const next = quoted ? `${quoted[0]}${trimmed}` : trimmed
      return { ...a, text: next }
    })
    setAnnotations(updated)
    saveAnnotations(workspaceId, updated)
    toast.success('Note updated.')
  }

  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!materialId) {
      setMaterial(null)
      return
    }
    // Cache hit: render the previously-fetched metadata immediately so
    // the header (title) doesn't blank. We still refresh in the
    // background so an edit made in another tab eventually shows up,
    // but the user sees no "loading" flash.
    const cachedMeta = metaCache.get(materialId)
    if (cachedMeta) {
      setMaterial(cachedMeta)
    } else {
      setLoading(true)
    }
    let aborted = false
    void (async () => {
      try {
        const all = await api<MaterialDetail[]>(
          `/projects/${projectId}/materials`,
          { auth: true },
        )
        if (aborted) return
        const found = all.find((m) => m.id === materialId) ?? null
        if (found) metaCache.set(materialId, found)
        else metaCache.delete(materialId)
        setMaterial(found)
      } catch {
        if (!aborted && !cachedMeta) setMaterial(null)
      } finally {
        if (!aborted) setLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [projectId, materialId])

  // Fetch the raw PDF bytes (auth-gated) and hand them to the inline
  // pdf.js reader. Skipped for non-PDF sources or when bytes weren't
  // retained — falls back to the chunk-based content view in that case.
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null)
  const [pdfMissing, setPdfMissing] = useState(false)
  useEffect(() => {
    setPdfMissing(false)
    if (!material || material.source_type !== 'pdf') {
      setPdfBlob(null)
      return
    }
    // Cache hit: hand the previously-fetched Blob to PdfReader
    // synchronously so the canvas is already painted from the cached
    // doc on this mount cycle — no blank "Loading PDF…" between
    // layout switches. The blob identity is stable across mounts so
    // PdfReader's load effect (keyed on `blob`) is a no-op when re-
    // mounted with the same cached blob.
    const cachedBlob = blobCache.get(material.id)
    if (cachedBlob) {
      setPdfBlob(cachedBlob)
      touchBlobLru(material.id)
      return
    }
    setPdfBlob(null)
    let aborted = false
    // Real AbortController for the fetch itself — passing the signal
    // lets the browser cancel the in-flight transfer when the material
    // changes / pane unmounts mid-download. The local `aborted` flag
    // still guards the post-await state setters in case the fetch
    // resolves between the abort and the catch.
    const controller = new AbortController()
    void (async () => {
      try {
        const blob = await apiBlob(`/materials/${material.id}/file`, {
          auth: true,
          signal: controller.signal,
        })
        if (aborted) return
        blobCache.set(material.id, blob)
        touchBlobLru(material.id)
        setPdfBlob(blob)
      } catch {
        if (!aborted) setPdfMissing(true)
      }
    })()
    return () => {
      aborted = true
      controller.abort()
    }
  }, [material])

  // Fetch the concatenated chunks text for non-PDF materials (notes,
  // URLs, and PDFs whose bytes weren't retained). Without this, the
  // reader pane only showed metadata — there was nothing to
  // highlight, which is why the user couldn't see the highlight
  // effect for note files. The content endpoint stitches chunks back
  // together in their original order so the user can select + mark
  // up real passages.
  const [contentText, setContentText] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  useEffect(() => {
    if (!material) {
      setContentText(null)
      return
    }
    // Skip when bytes-PDFs are loading — the inline pdf.js view owns
    // the body in that case.
    if (material.source_type === 'pdf' && !pdfMissing) return
    // Cache hit: render existing text instantly.
    const cachedContent = contentCache.get(material.id)
    if (cachedContent !== undefined) {
      setContentText(cachedContent)
      return
    }
    setContentText(null)
    setContentLoading(true)
    let aborted = false
    void (async () => {
      try {
        const out = await api<{ content: string }>(
          `/materials/${material.id}/content`,
          { auth: true },
        )
        if (aborted) return
        const text = out.content ?? ''
        contentCache.set(material.id, text)
        setContentText(text)
      } catch {
        if (!aborted) setContentText('')
      } finally {
        if (!aborted) setContentLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [material, pdfMissing])

  if (!material) {
    return (
      <section
        aria-label="Reader"
        aria-busy={loading || undefined}
        className="pane"
        style={{ height: '100%' }}
      >
        <div className="pane-header">
          <Icons.eye size={14} />
          <div style={{ fontSize: 13, fontWeight: 500 }}>Reader</div>
        </div>
        <div
          className="pane-body"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#fff',
            color: 'var(--color-muted)',
            textAlign: 'center',
            padding: 32,
          }}
        >
          <div style={{ maxWidth: 320, lineHeight: 1.55, fontSize: 13.5 }}>
            Pick a material from the sidebar — its passages will show up here
            with your highlights and notes.
          </div>
        </div>
      </section>
    )
  }

  const Icon =
    material.source_type === 'pdf'
      ? Icons.pdf
      : material.source_type === 'url'
        ? Icons.doc
        : Icons.note
  // Some legacy materials have null metadata (pre-migration); coerce
  // to empty object so the chrome renders without a runtime crash.
  const meta: { pages?: number; extracted_title?: string; arxiv_id?: string } =
    (material.metadata as Record<string, unknown> | null) ?? {}

  return (
    <>
    <section
      key={pulseKey > 0 ? `pulse-${pulseKey}` : 'reader'}
      aria-label="Reader"
      aria-busy={loading || undefined}
      data-reader-pulse={pulseKey > 0 ? 'true' : undefined}
      className="pane"
      style={{ height: '100%' }}
    >
      <div className="pane-header">
        <Icon size={14} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={material.title ?? undefined}
          >
            {material.title ?? 'Untitled'}
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--color-muted)',
              letterSpacing: '0.04em',
            }}
          >
            {meta.arxiv_id
              ? `arXiv:${meta.arxiv_id}`
              : material.source_type.toUpperCase()}
            {meta.pages ? ` · ${meta.pages} pages` : ''}
          </div>
        </div>
        <div
          role="toolbar"
          aria-label="Reader actions"
          style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}
        >
          {/* `onMouseDown → preventDefault` keeps the user's text
              selection alive when they click these buttons. Without it,
              the button takes focus on mousedown and the browser
              collapses the selection before `onClick` runs, so the
              instant-highlight handler reads an empty selection. */}
          {/* Top-toolbar Highlight is a power-user shortcut — defaults
              to yellow, the most common highlight color. The canonical
              affordance is the floating selection toolbar that pops up
              above the selection itself with the full color picker. */}
          <button
            type="button"
            className="ns-btn ghost tiny"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => highlightFromSelection('yellow')}
            title="Highlight selection in yellow (use the floating toolbar for other colors)"
          >
            Highlight
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openNoteEditor({
                top: r.bottom,
                left: r.left,
                right: r.right,
                bottom: r.bottom + 4,
              })
            }}
            title="Add a note (anchors to your selection if any)"
          >
            Note
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => {
              // Annotations are kept in localStorage and persisted on
              // every add/delete. This explicit Save action is the
              // visible "commit" gesture the user asked for — flushes
              // the in-memory list and acknowledges with a toast so
              // there's no doubt the changes survived.
              saveAnnotations(workspaceId, annotations)
              toast.success(
                ownAnnotations.length === 0
                  ? 'No annotations to save yet.'
                  : `Saved ${ownAnnotations.length} annotation${ownAnnotations.length === 1 ? '' : 's'}.`,
              )
            }}
            title="Save annotations for this material"
            aria-label="Save annotations"
          >
            <Icons.send size={12} /> Save
          </button>
          {/* The external-link button is only meaningful for URL
              materials — uploaded PDFs and inline notes have no
              external URL to open, so hiding it removes a dead
              affordance. */}
          {material.source_type === 'url' && material.uri && (
            <button
              type="button"
              className="ns-btn ghost tiny"
              style={{ padding: '4px 6px' }}
              onClick={() => {
                // Validate the scheme before opening — a malicious uri
                // (`javascript:`, `data:`, etc.) on a URL material would
                // otherwise execute in the new tab's origin. The check
                // lives in `lib/redirect.ts` so it stays consistent
                // with the `?next=` open-redirect defense.
                if (material.uri && isSafeHttpUrl(material.uri)) {
                  openInSystemBrowser(material.uri)
                } else {
                  toast.warn("This URL can't be opened safely.")
                }
              }}
              aria-label="Open original source"
              title="Open original URL in a new tab"
            >
              <Icons.arrowsOut size={12} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={bodyRef}
        className="pane-body"
        style={{
          padding: pdfBlob ? 0 : '22px 28px',
          background: '#fff',
          // When rendering a PDF, the PdfReader handles its own scroll
          // container — letting `.pane-body` also scroll produces a
          // double scrollbar on the right edge. Suppress the outer
          // scroll only in the PDF case; text/note bodies still scroll
          // the pane-body as before.
          overflow: pdfBlob ? 'hidden' : 'auto',
        }}
      >
        {pdfBlob ? (
          <Suspense
            fallback={
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--color-muted)',
                  fontSize: 12.5,
                }}
              >
                Loading PDF reader…
              </div>
            }
          >
            <PdfReader
              blob={pdfBlob}
              title={material.title ?? 'document'}
              onError={onPdfError}
              onNotice={(msg) => toastRef.current.success(msg)}
              highlights={highlightsForReader}
              notes={notesForReader}
              onDelete={deleteAnnotation}
              onMoveNote={moveAnnotation}
              onEditNote={editAnnotation}
            />
          </Suspense>
        ) : (
          <>
            <div
              className="font-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.1em',
                color: 'var(--color-muted)',
                marginBottom: 6,
              }}
            >
              {material.source_type === 'pdf' && pdfMissing
                ? '§1 · BYTES UNAVAILABLE'
                : '§1 · METADATA'}
            </div>
            <h2
              className="font-serif"
              style={{
                fontSize: 22,
                lineHeight: 1.2,
                margin: '0 0 12px',
                fontWeight: 500,
              }}
            >
              {material.title ?? 'Untitled'}
            </h2>
            {contentLoading && contentText === null ? (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--color-muted)',
                  fontStyle: 'italic',
                }}
              >
                Loading content…
              </div>
            ) : contentText && contentText.trim() ? (
              // Real content from chunks — render with highlight overlays
              // baked in so the user actually sees their highlights on
              // the text. Selection still works (the wrapper is text-
              // selectable), and TextHighlighted slots in <mark> tags
              // around the matched passages.
              <TextHighlighted
                content={contentText}
                highlights={highlightsForReader}
                notes={notesForReader}
                onDelete={deleteAnnotation}
                onMoveNote={moveAnnotation}
                onEditNote={editAnnotation}
              />
            ) : (
              <p
                className="font-serif"
                style={{
                  fontSize: 14,
                  lineHeight: 1.65,
                  color: 'var(--color-ink-2)',
                  margin: '0 0 12px',
                }}
              >
                {material.source_type === 'pdf' && pdfMissing
                  ? 'The original PDF bytes are not stored for this material — it was ingested before bytes-retention was wired in. Re-upload the PDF to enable inline rendering.'
                  : 'This source has no inline content yet — open the original URL above, or use the chat to query its indexed contents.'}
              </p>
            )}
          </>
        )}
        {!pdfBlob && material.uri && (
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--color-paper-2)',
              border: '1px dashed var(--color-rule-2)',
              borderRadius: 8,
              fontSize: 13,
              color: 'var(--color-ink-2)',
              margin: '14px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 10.5,
                color: 'var(--color-muted)',
                letterSpacing: '0.08em',
              }}
            >
              SOURCE URL
            </div>
            {isSafeHttpUrl(material.uri) ? (
              <a
                href={material.uri}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  openInSystemBrowser(material.uri)
                }}
                style={{
                  color: 'var(--color-indigo)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12.5,
                  wordBreak: 'break-all',
                }}
              >
                {material.uri}
              </a>
            ) : (
              // Don't render a clickable link for non-http(s) schemes —
              // `javascript:` / `data:` etc. would execute or open
              // unexpected content. Show the value as plain text so
              // the user can still see what's stored.
              <span
                className="font-mono"
                title="This source URL is not a safe http(s) link."
                style={{
                  color: 'var(--color-muted)',
                  fontSize: 12.5,
                  wordBreak: 'break-all',
                }}
              >
                {material.uri}
              </span>
            )}
          </div>
        )}
        {ownAnnotations.length > 0 && (
          <section
            aria-label="Your annotations"
            style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 10.5,
                letterSpacing: '0.08em',
                color: 'var(--color-muted)',
                textTransform: 'uppercase',
              }}
              aria-hidden
            >
              Your annotations · {ownAnnotations.length}
            </div>
            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ownAnnotations.map((a) => (
              <li
                key={a.id}
                style={{
                  padding: '10px 12px',
                  background:
                    a.kind === 'highlight'
                      ? 'color-mix(in oklch, var(--color-indigo) 8%, white)'
                      : 'var(--color-paper-2)',
                  border:
                    a.kind === 'highlight'
                      ? '1px solid color-mix(in oklch, var(--color-indigo) 25%, transparent)'
                      : '1px dashed var(--color-rule-2)',
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 10.5,
                    color: 'var(--color-muted)',
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.08em',
                  }}
                >
                  <span>{a.kind === 'highlight' ? 'HIGHLIGHT' : 'NOTE'}</span>
                  <span>·</span>
                  <span>{fmtRelative(a.createdAt)}</span>
                  <button
                    type="button"
                    onClick={() => deleteAnnotation(a.id)}
                    aria-label={`Delete ${a.kind === 'highlight' ? 'highlight' : 'note'}`}
                    title="Delete"
                    style={{
                      marginLeft: 'auto',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--color-muted)',
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    <span aria-hidden>✕</span>
                  </button>
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--color-ink-2)', lineHeight: 1.55 }}>
                  {a.text}
                </div>
              </li>
            ))}
            </ul>
          </section>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button
            type="button"
            className="ns-btn ghost tiny"
            disabled={!onAskAboutPassage}
            onClick={() => {
              if (!onAskAboutPassage) return
              // No prefill — the chat pane should look identical
              // whether the user got here by clicking this button or
              // by switching layout modes. The reader still gets
              // surfaced as scope via the material chip in the
              // sources strip.
              onAskAboutPassage('')
            }}
          >
            Ask about this passage →
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => {
              toast.toast(
                'Cited sources are pinned to the graph automatically — see the Citations lens.',
              )
            }}
          >
            Pin to graph
          </button>
        </div>
      </div>
    </section>
    <SelectionToolbar
      selection={selection}
      onHighlight={highlightFromSelection}
      onNote={() => openNoteEditor()}
    />
    <NoteEditor
      draft={noteDraft}
      onChange={(text) =>
        setNoteDraft((cur) => (cur ? { ...cur, text } : cur))
      }
      onSave={() => {
        if (!noteDraft) return
        const body =
          noteDraft.seed && noteDraft.text
            ? `> ${noteDraft.seed}\n\n${noteDraft.text}`
            : noteDraft.text || noteDraft.seed
        if (!body.trim()) {
          toast.toast('Type a note first, or select a passage to attach it to.')
          return
        }
        if (persistAnnotation('note', body, undefined, noteDraft.pdfRects)) {
          window.getSelection()?.removeAllRanges()
          setSelection(null)
          setNoteDraft(null)
        }
      }}
      onClose={() => setNoteDraft(null)}
    />
    </>
  )
}

/**
 * Renders note / URL material content as readable prose with persisted
 * highlights baked in as <mark> tags. The selection toolbar still
 * works on top of this because <mark> is a plain inline element — it
 * doesn't break drag-select or word/line click selection.
 *
 * For each highlight, we find its passage in the content and wrap
 * those characters with a styled mark. Overlapping highlights are
 * handled by emitting them in document order; later highlights inside
 * an earlier one are noticed but currently rendered as a single
 * stronger swatch (acceptable for v1).
 */
function TextHighlighted({
  content,
  highlights,
  notes,
  onDelete,
  onMoveNote,
  onEditNote,
}: {
  content: string
  highlights: { id: string; text: string; overlay: string }[]
  notes: {
    id: string
    text: string
    position?: { left: number; top: number }
  }[]
  onDelete: (id: string) => void
  onMoveNote: (id: string, position: { left: number; top: number }) => void
  onEditNote: (id: string, text: string) => void
}) {
  // Build a list of [start, end, overlay, id] spans by searching each
  // highlight text in the content.
  const ranges: { start: number; end: number; overlay: string; id: string }[] = []
  for (const h of highlights) {
    if (!h.text) continue
    let from = 0
    while (from <= content.length - h.text.length) {
      const idx = content.indexOf(h.text, from)
      if (idx < 0) break
      ranges.push({ start: idx, end: idx + h.text.length, overlay: h.overlay, id: h.id })
      from = idx + h.text.length
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  // Merge fully-overlapping ranges so we don't double-mark. When two
  // overlapping highlights have different colors, we keep the FIRST
  // one's color (predictable + matches how the user added them).
  const merged: typeof ranges = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }

  // For each note, find a passage in the content to anchor against.
  // The default position of the sticky-note marker is computed
  // post-render from the passage's bounding rect (see the overlay
  // effect below). When the user has dragged the marker, that
  // explicit position takes precedence.
  const noteAnchors = notes
    .map((n) => {
      const quoted = /^>\s*([^\n]+)/.exec(n.text)
      const probe = (quoted?.[1] ?? n.text.split('\n')[0] ?? '').trim()
      const idx = probe ? content.indexOf(probe) : -1
      return {
        id: n.id,
        text: n.text,
        probe,
        anchorOffset: idx >= 0 ? idx : 0,
        position: n.position,
      }
    })

  // Walk content + ranges, emitting plain text and <mark> elements.
  // (Notes are NOT inlined here — they live in a separate overlay so
  // they can be dragged independently of the text flow.)
  const stops = new Set<number>()
  for (const r of merged) {
    stops.add(r.start)
    stops.add(r.end)
  }
  const sorted = [...stops].sort((a, b) => a - b)

  const out: React.ReactNode[] = []
  let cursor = 0
  let key = 0
  const pushText = (slice: string) => {
    if (!slice) return
    out.push(...splitTextWithLinks(slice, `t-${key}`))
    key += 1
  }
  for (const stop of sorted) {
    if (stop > cursor) pushText(content.slice(cursor, stop))
    cursor = stop
    const startingMark = merged.find((r) => r.start === stop)
    if (startingMark) {
      const seg = content.slice(startingMark.start, startingMark.end)
      out.push(
        <HighlightMark
          key={`hl-${key++}`}
          id={startingMark.id}
          overlay={startingMark.overlay}
          onDelete={onDelete}
        >
          {seg}
        </HighlightMark>,
      )
      cursor = startingMark.end
    }
  }
  if (cursor < content.length) pushText(content.slice(cursor))

  // Layout: relative-positioned wrapper holds the text + an overlay
  // layer with absolutely-positioned, draggable sticky-note markers.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [resolved, setResolved] = useState<
    { id: string; text: string; left: number; top: number; explicit: boolean }[]
  >([])

  // Wrap size tracking: when the reading column resizes (window resize,
  // splitter drag, font-density change), the persisted fractional
  // positions need to be re-resolved to current px or the markers
  // drift relative to the text underneath. We use a ResizeObserver so
  // the layout effect re-fires automatically without manual triggers.
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setWrapSize((cur) =>
        Math.abs(cur.w - r.width) < 0.5 && Math.abs(cur.h - r.height) < 0.5
          ? cur
          : { w: r.width, h: r.height },
      )
    })
    ro.observe(el)
    const r0 = el.getBoundingClientRect()
    setWrapSize({ w: r0.width, h: r0.height })
    return () => ro.disconnect()
  }, [])

  // Resolve each note's marker position. Persisted positions are
  // stored as fractions (0..1) of the wrap viewport so they survive
  // window-resize and column-width changes without drifting. Legacy
  // values saved as raw pixels (pre-2026-05-12) are still honored —
  // any axis > 1.5 is treated as px and used directly. The migration
  // happens on next drag: `onMoveNote` always saves the fraction.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const text = textRef.current
    if (!wrap || !text) return
    const wrapRect = wrap.getBoundingClientRect()
    const next = noteAnchors.map((n) => {
      if (n.position) {
        const p = n.position
        const isFraction =
          Math.abs(p.left) <= 1.5 && Math.abs(p.top) <= 1.5
        if (isFraction && wrapRect.width > 0 && wrapRect.height > 0) {
          return {
            id: n.id,
            text: n.text,
            left: p.left * wrapRect.width,
            top: p.top * wrapRect.height,
            explicit: true,
          }
        }
        // Legacy pixels — auto-upgrade on next tick so subsequent
        // re-renders track the page instead of drifting. Use the
        // current wrap size as the reference: future renders compute
        // the same px so the marker doesn't visibly jump.
        if (wrapRect.width > 0 && wrapRect.height > 0) {
          const fx = p.left / wrapRect.width
          const fy = p.top / wrapRect.height
          queueMicrotask(() => onMoveNote(n.id, { left: fx, top: fy }))
        }
        return {
          id: n.id,
          text: n.text,
          left: p.left,
          top: p.top,
          explicit: true,
        }
      }
      // Walk text nodes to find n.probe and compute its bounding rect.
      let left = wrapRect.width - 26
      let top = 8
      if (n.probe) {
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode as Text
          const t = node.textContent ?? ''
          const idx = t.indexOf(n.probe)
          if (idx >= 0) {
            const range = document.createRange()
            range.setStart(node, idx)
            range.setEnd(node, Math.min(t.length, idx + n.probe.length))
            const r = range.getBoundingClientRect()
            // Position the marker to the right of the line, inside
            // the wrap bounds so it stays visible.
            left = Math.min(
              wrapRect.width - 26,
              Math.max(0, r.right - wrapRect.left + 8),
            )
            top = r.top - wrapRect.top - 2
            break
          }
        }
      }
      return { id: n.id, text: n.text, left, top, explicit: false }
    })
    setResolved(next)
    // Re-run when notes change, the content scrolls/resizes, or the
    // wrap dimensions change (window resize via ResizeObserver above).
  }, [
    JSON.stringify(noteAnchors.map((n) => [n.id, n.probe, n.position])),
    content,
    wrapSize.w,
    wrapSize.h,
    onMoveNote,
  ])

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div
        ref={textRef}
        className="font-serif"
        style={{
          fontSize: 14,
          lineHeight: 1.75,
          color: 'var(--color-ink)',
          whiteSpace: 'pre-wrap',
          userSelect: 'text',
          // Limit reading column so long lines don't fatigue the eye.
          maxWidth: 720,
        }}
      >
        {out}
      </div>
      {resolved.map((n) => (
        <DraggableStickyNote
          key={n.id}
          id={n.id}
          text={n.text}
          left={n.left}
          top={n.top}
          wrapRef={wrapRef}
          onMove={(pos) => onMoveNote(n.id, pos)}
          onDelete={() => onDelete(n.id)}
          onEdit={(text) => onEditNote(n.id, text)}
        />
      ))}
    </div>
  )
}

/**
 * Absolutely-positioned, draggable sticky-note marker for inline
 * note-file content. Renders a tiny yellow tab; click toggles the
 * full sticky-note card alongside it. Drag the tab to a new position
 * and it's persisted via `onMove`.
 */
function DraggableStickyNote({
  id,
  text,
  left,
  top,
  wrapRef,
  onMove,
  onDelete,
  onEdit,
}: {
  id: string
  text: string
  left: number
  top: number
  wrapRef: React.RefObject<HTMLDivElement | null>
  onMove: (pos: { left: number; top: number }) => void
  onDelete: () => void
  onEdit: (text: string) => void
}) {
  const markerRef = useRef<HTMLButtonElement | null>(null)
  // Mirror props into state so drag updates render smoothly without
  // waiting for the parent to round-trip the new position.
  const [pos, setPos] = useState({ left, top })
  useEffect(() => {
    setPos({ left, top })
  }, [left, top])
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Drag handling. Mirror PdfReader's threshold: <4px is a click, more
  // is a drag (and suppresses the synthesized click).
  useEffect(() => {
    const marker = markerRef.current
    if (!marker) return
    let downX = 0
    let downY = 0
    let startLeft = 0
    let startTop = 0
    let didDrag = false
    const onMove_ = (e: PointerEvent) => {
      const dx = e.clientX - downX
      const dy = e.clientY - downY
      if (!didDrag && Math.hypot(dx, dy) < 4) return
      didDrag = true
      setDragging(true)
      const wrap = wrapRef.current
      if (!wrap) return
      const wrapRect = wrap.getBoundingClientRect()
      const nl = Math.max(0, Math.min(wrapRect.width - 18, startLeft + dx))
      const nt = Math.max(0, Math.min(wrapRect.height - 18, startTop + dy))
      setPos({ left: nl, top: nt })
    }
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove_)
      window.removeEventListener('pointerup', onUp)
      if (didDrag) {
        // Persist as a FRACTION of the current wrap so the marker
        // tracks the page through future window resizes / column
        // reflows. Absolute pixels would drift the moment the wrap
        // changes width (which the user just experienced after a
        // window switch).
        setPos((cur) => {
          const wrap = wrapRef.current
          if (wrap) {
            const wr = wrap.getBoundingClientRect()
            const fx = wr.width > 0 ? cur.left / wr.width : 0
            const fy = wr.height > 0 ? cur.top / wr.height : 0
            onMove({ left: fx, top: fy })
          }
          return cur
        })
        // Suppress the synthesized click that comes right after a
        // pointerup at the same position.
        const stopClick = (ev: MouseEvent) => {
          ev.stopPropagation()
          ev.preventDefault()
          window.removeEventListener('click', stopClick, true)
        }
        window.addEventListener('click', stopClick, true)
        e.preventDefault()
      }
      // Reset drag flag on next tick so the click handler can read it.
      window.setTimeout(() => {
        setDragging(false)
        didDrag = false
      }, 0)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      downX = e.clientX
      downY = e.clientY
      startLeft = pos.left
      startTop = pos.top
      didDrag = false
      window.addEventListener('pointermove', onMove_)
      window.addEventListener('pointerup', onUp)
    }
    marker.addEventListener('pointerdown', onDown)
    return () => marker.removeEventListener('pointerdown', onDown)
  }, [pos.left, pos.top, onMove, wrapRef])

  // Close on Esc + click-outside.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (markerRef.current?.contains(e.target as Node)) return
      const pop = document.getElementById(`notesci-card-${id}`)
      if (pop?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, id])

  const body = text.replace(/^>\s*[^\n]+\n+/, '').trim() || text
  // Local edit-buffer state. Re-syncs when the card opens or the
  // upstream note text changes (e.g. after a successful save the
  // parent feeds back the canonical text).
  const [draft, setDraft] = useState(body)
  useEffect(() => {
    setDraft(body)
  }, [body, open])
  const isDirty = draft.trim() !== body.trim() && draft.trim().length > 0
  // Flip the card to the right of the marker when the marker is too
  // close to the left edge of the wrap.
  const cardOnRight = pos.left < 250
  return (
    <>
      <button
        ref={markerRef}
        type="button"
        onClick={(e) => {
          if (dragging) return
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        title={`Drag to move · click to open · ${body.slice(0, 60)}`}
        aria-label="Sticky note"
        style={{
          position: 'absolute',
          left: pos.left,
          top: pos.top,
          width: 18,
          height: 18,
          background: '#fff2a8',
          border: '1px solid #d6b85a',
          borderRadius: 2,
          color: '#3d2f00',
          fontSize: 11,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: dragging ? 'grabbing' : 'grab',
          padding: 0,
          boxShadow: '0 1px 3px rgba(60,40,0,0.22)',
          touchAction: 'none',
          userSelect: 'none',
          zIndex: 5,
        }}
      >
        ✎
      </button>
      {open && (
        <div
          id={`notesci-card-${id}`}
          role="dialog"
          aria-label="Sticky note"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: cardOnRight ? pos.left + 26 : pos.left - 246,
            top: pos.top,
            width: 240,
            background: '#fff4b8',
            border: '1px solid #d6b85a',
            borderRadius: 4,
            boxShadow: '0 10px 24px rgba(60,40,0,0.22)',
            padding: '10px 12px',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: '#3d2f00',
            zIndex: 6,
            userSelect: 'text',
          }}
        >
          <div
            className="font-mono"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'rgba(61,47,0,0.6)',
              marginBottom: 6,
            }}
          >
            <span>Edit note</span>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                onDelete()
                setOpen(false)
              }}
              aria-label="Delete note"
              title="Delete note"
              style={{
                background: 'rgba(176,58,46,0.10)',
                border: '1px solid rgba(176,58,46,0.32)',
                borderRadius: 4,
                color: 'rgba(61,47,0,0.65)',
                fontSize: 11,
                cursor: 'pointer',
                padding: '3px 7px',
                lineHeight: 1,
              }}
            >
              Delete
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (isDirty) {
                  onEdit(draft.trim())
                }
              }
            }}
            rows={5}
            style={{
              width: '100%',
              minHeight: 80,
              boxSizing: 'border-box',
              resize: 'vertical',
              background: 'rgba(255,255,255,0.55)',
              border: '1px solid rgba(214,184,90,0.6)',
              borderRadius: 3,
              padding: '6px 8px',
              font: 'inherit',
              fontSize: 12.5,
              lineHeight: 1.5,
              color: '#3d2f00',
              outline: 'none',
              whiteSpace: 'pre-wrap',
            }}
            aria-label="Edit note body"
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 8,
              gap: 6,
            }}
          >
            <span style={{ fontSize: 10.5, color: 'rgba(61,47,0,0.55)' }}>
              ⌘↩ to save
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setDraft(body)}
                disabled={!isDirty}
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(214,184,90,0.6)',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontSize: 11.5,
                  color: 'rgba(61,47,0,0.75)',
                  cursor: isDirty ? 'pointer' : 'not-allowed',
                  opacity: isDirty ? 1 : 0.5,
                }}
              >
                Revert
              </button>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  if (!isDirty) return
                  onEdit(draft.trim())
                }}
                disabled={!isDirty}
                aria-label="Save note edits"
                style={{
                  background: isDirty ? '#3d2f00' : 'rgba(61,47,0,0.3)',
                  color: '#fff4b8',
                  border: 'none',
                  borderRadius: 4,
                  padding: '4px 10px',
                  fontSize: 11.5,
                  cursor: isDirty ? 'pointer' : 'not-allowed',
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * One highlighted passage. Renders as a colored <mark> with a small
 * "×" delete affordance that appears on hover at the top-right corner.
 * Clicking the × removes the annotation via the supplied callback.
 */
function HighlightMark({
  id,
  overlay,
  onDelete,
  children,
}: {
  id: string
  overlay: string
  onDelete: (id: string) => void
  children: React.ReactNode
}) {
  // Click toggles a small popover with a Delete button. The popover
  // is portalled to escape `<mark>`'s inline display and any
  // overflow:hidden ancestors. Closes on Esc or click-outside.
  const [open, setOpen] = useState(false)
  const markRef = useRef<HTMLElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )
  useLayoutEffect(() => {
    if (!open || !markRef.current) {
      setAnchor(null)
      return
    }
    const r = markRef.current.getBoundingClientRect()
    setAnchor({ top: r.bottom + 6, left: r.right - 8 })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (markRef.current?.contains(e.target as Node)) return
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <>
        <mark
        ref={markRef as React.RefObject<HTMLElement>}
        onClick={(e) => {
          // Only react to plain clicks, not drag-end clicks that
          // happen at the boundary of a fresh selection.
          if (window.getSelection?.()?.toString().trim()) return
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{
          background: overlay,
          color: 'inherit',
          padding: '0 1px',
          borderRadius: 2,
          cursor: 'pointer',
          display: 'inline',
        }}
        title="Click for delete option"
      >
        {typeof children === 'string' ? splitTextWithLinks(children, `hl-${id}`) : children}
      </mark>
      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popRef}
              role="menu"
              aria-label="Highlight actions"
              style={{
                position: 'fixed',
                top: anchor.top,
                left: anchor.left,
                background: 'var(--color-ink)',
                color: '#fff',
                borderRadius: 8,
                boxShadow: '0 10px 24px rgba(14,17,22,0.32)',
                padding: 4,
                display: 'inline-flex',
                gap: 2,
                zIndex: 95,
                fontSize: 12.5,
                userSelect: 'none',
              }}
            >
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onDelete(id)
                  setOpen(false)
                }}
                style={{
                  background: 'transparent',
                  color: 'inherit',
                  border: 'none',
                  padding: '6px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = 'transparent')
                }
                aria-label="Delete highlight"
              >
                <span aria-hidden>×</span> Delete highlight
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}


/**
 * Floating toolbar that appears just above the user's text selection
 * inside the reader body. Two actions: Highlight (instant) and Note
 * (opens the inline note editor). Portalled to document.body so the
 * pane's `overflow: hidden` can't clip it.
 *
 * `onMouseDown → preventDefault` on the buttons is critical — without
 * it, clicking would shift focus away from the selection and the
 * browser would collapse it before the click handler runs.
 */
function SelectionToolbar({
  selection,
  onHighlight,
  onNote,
}: {
  selection: {
    text: string
    rect: { top: number; left: number; right: number; bottom: number }
  } | null
  onHighlight: (color: HighlightColor) => void
  onNote: () => void
}) {
  // Single-row layout: every highlight color is one click away. The
  // previous "Highlight → expand → pick" flow buried the color choice
  // behind two clicks and felt slow; surfacing all five swatches keeps
  // the most-common action one tap deep while preserving the Note
  // affordance on the far end.
  if (!selection || typeof document === 'undefined') return null
  const { rect } = selection
  // Position the toolbar so it never overlaps the selected text.
  // Prefer ABOVE the selection (cursor's natural resting spot when
  // dragging downward), with a 12px gap. If the selection's top edge
  // is too close to the viewport top to fit the toolbar above it,
  // flip BELOW the selection's bottom edge — also a 12px gap so the
  // toolbar reads as "attached to the bottom of the passage" rather
  // than floating on top of the words.
  const TOOLBAR_H = 42
  const GAP = 12
  const viewportH =
    typeof window !== 'undefined' ? window.innerHeight : 800
  const canFitAbove = rect.top - GAP - TOOLBAR_H >= 8
  const top = canFitAbove
    ? rect.top - GAP - TOOLBAR_H
    : Math.min(viewportH - TOOLBAR_H - 8, rect.bottom + GAP)
  // Horizontally center on the selection, but clamp so the toolbar
  // doesn't slip off the viewport edges. The transform below shifts
  // the anchor by -50%, so we keep ``left`` between half-toolbar-width
  // (~140px) and viewport-width minus that.
  const HALF_W = 170
  const viewportW =
    typeof window !== 'undefined' ? window.innerWidth : 1024
  const left = Math.max(
    HALF_W + 8,
    Math.min(viewportW - HALF_W - 8, (rect.left + rect.right) / 2),
  )
  const baseBtn: React.CSSProperties = {
    background: 'transparent',
    color: 'inherit',
    border: 'none',
    padding: '6px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    pointerEvents: 'auto',
  }
  return createPortal(
    <div
      role="toolbar"
      aria-label="Selection actions"
      data-notesci-sel-toolbar="1"
      style={{
        position: 'fixed',
        top,
        left,
        transform: 'translateX(-50%)',
        zIndex: 80,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: 4,
        background: 'var(--color-ink)',
        color: '#fff',
        borderRadius: 8,
        boxShadow: '0 6px 18px rgba(14,17,22,0.32)',
        fontSize: 12.5,
        userSelect: 'none',
        // `pointer-events: none` on the wrapper lets a subsequent
        // drag-select pass through the toolbar background to the
        // text-layer beneath it. Interactive children below re-enable
        // pointer events on themselves so they remain clickable.
        pointerEvents: 'none',
      }}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          // mousedown.preventDefault keeps the selection alive while
          // the user clicks — without this the textarea's focus would
          // collapse the range before onHighlight can read it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onHighlight(c.id)}
          title={`Highlight in ${c.label.toLowerCase()}`}
          aria-label={`Highlight in ${c.label}`}
          style={{
            ...baseBtn,
            padding: 4,
            width: 26,
            height: 26,
            justifyContent: 'center',
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = 'rgba(255,255,255,0.18)')
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = 'transparent')
          }
        >
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: c.swatch,
              boxShadow:
                '0 0 0 1.5px rgba(255,255,255,0.55) inset, 0 1px 2px rgba(0,0,0,0.18)',
            }}
          />
        </button>
      ))}
      <span
        aria-hidden
        style={{
          width: 1,
          height: 18,
          background: 'rgba(255,255,255,0.18)',
          margin: '0 2px',
        }}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNote}
        style={baseBtn}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = 'transparent')
        }
        title="Write a note about this passage"
      >
        Note
      </button>
    </div>,
    document.body,
  )
}

/**
 * Inline note editor anchored near the selection. Not a modal — it's
 * a small popover that the user can dismiss with Esc or by clicking
 * outside. Echoes the selected passage as a blockquote above the
 * textarea so the user always sees what they're annotating.
 */
function NoteEditor({
  draft,
  onChange,
  onSave,
  onClose,
}: {
  draft: { seed: string; rect: { top: number; left: number; right: number; bottom: number }; text: string } | null
  onChange: (text: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )

  useLayoutEffect(() => {
    if (!draft) {
      setAnchor(null)
      return
    }
    const W = 320
    const H = 200
    const VW = typeof window === 'undefined' ? 1024 : window.innerWidth
    const VH = typeof window === 'undefined' ? 768 : window.innerHeight
    let top = draft.rect.bottom + 8
    let left = (draft.rect.left + draft.rect.right) / 2 - W / 2
    // Flip below → above if the popover would overflow the viewport.
    if (top + H > VH - 12) top = Math.max(12, draft.rect.top - H - 8)
    if (left < 12) left = 12
    if (left + W > VW - 12) left = VW - W - 12
    setAnchor({ top, left })
    // Focus into the textarea so the user can start typing immediately.
    queueMicrotask(() => textareaRef.current?.focus())
  }, [draft])

  useEffect(() => {
    if (!draft) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onSave()
      }
    }
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    // Defer doc click so the click that opened the editor doesn't
    // immediately close it.
    const t = window.setTimeout(
      () => document.addEventListener('mousedown', onDoc),
      0,
    )
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [draft, onSave, onClose])

  if (!draft || !anchor || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="Add a note"
      style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
        width: 320,
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 10,
        boxShadow: '0 18px 36px -8px rgba(14,17,22,0.22)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 90,
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.1em',
          color: 'var(--color-muted)',
          textTransform: 'uppercase',
        }}
      >
        {draft.seed ? 'Note on passage' : 'Note'}
      </div>
      {draft.seed && (
        <blockquote
          style={{
            margin: 0,
            padding: '6px 10px',
            borderLeft: '2px solid var(--color-indigo)',
            background: 'var(--color-paper-2)',
            fontSize: 12,
            color: 'var(--color-ink-2)',
            lineHeight: 1.45,
            maxHeight: 70,
            overflow: 'auto',
            borderRadius: 4,
          }}
        >
          {draft.seed}
        </blockquote>
      )}
      <textarea
        ref={textareaRef}
        className="ns-input"
        value={draft.text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What stood out to you?"
        rows={4}
        style={{ resize: 'vertical', fontSize: 13, lineHeight: 1.5, minHeight: 70 }}
        aria-label="Note text"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10.5, color: 'var(--color-muted)' }}>
          ⌘↩ to save · Esc to cancel
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ns-btn tiny"
            onClick={onSave}
            disabled={!draft.text.trim() && !draft.seed.trim()}
          >
            Save note
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
