import {
  Component,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '../icons'
import { api, errorMessage } from '../../lib/api'
import { useToast } from '../Toast'

/**
 * Pane-level error boundary. Catches render-phase exceptions in any one
 * workspace pane (graph, chat, side) so a single buggy component
 * degrades to an inline message instead of crashing the whole app via
 * the top-level ErrorBoundary's "Something went wrong" surface.
 *
 * Reset uses ``resetKey`` — incrementing it via React's ``key`` prop on
 * the children-wrapper forces a fresh remount, so transient state
 * (stale refs, captured closures) clears. The pane's own data fetches
 * re-run from scratch.
 *
 * Exported so any pane container can wrap its child — see
 * ``Workspace.tsx`` which wraps GraphPane and ChatPane individually.
 */
export class PaneErrorBoundary extends Component<
  { children: ReactNode; paneName: string },
  { hasError: boolean; resetKey: number }
> {
  state = { hasError: false, resetKey: 0 }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[${this.props.paneName}] render failed`,
      error,
      info.componentStack,
    )
  }
  private reset = () => {
    this.setState((s) => ({ hasError: false, resetKey: s.resetKey + 1 }))
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 24,
            textAlign: 'center',
            color: 'var(--color-muted)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div style={{ maxWidth: 320 }}>
            <div
              style={{
                marginBottom: 6,
                color: 'var(--color-ink-2)',
                fontWeight: 500,
              }}
            >
              The {this.props.paneName} pane hit an error.
            </div>
            <div style={{ marginBottom: 12 }}>
              The rest of the workspace still works. The underlying error
              is in the browser console (F12) if you want to share it.
            </div>
            <button
              type="button"
              onClick={this.reset}
              className="ns-btn ghost tiny"
              style={{ padding: '4px 10px', fontSize: 12 }}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    // ``key`` forces React to remount the subtree when we reset, so any
    // stale refs / suspended fetches inside don't keep throwing.
    //
    // ``display: contents`` keeps this wrapper invisible to layout — the
    // child inherits the surrounding flex sizing directly. Without it a
    // plain ``<div>`` wrapper inside ResizableSplit would collapse the
    // pane to its content height because the wrapper doesn't carry
    // ``flex: 1``.
    return (
      <div key={this.state.resetKey} style={{ display: 'contents' }}>
        {this.props.children}
      </div>
    )
  }
}

export type GraphMode = 'map' | 'citations' | 'concepts' | 'reasoning'

type NodeType = 'turn' | 'chunk' | 'material' | 'concept'

interface GraphFilters {
  hiddenTypes: ReadonlySet<NodeType>
  /** Minimum concept-hub weight (degree). Used by Map mode to hide
   *  one-off concepts that only bridge a single source. */
  minWeight: number
  /** Case-insensitive label substring filter. Empty string = off. */
  query: string
}

const ALL_TYPES: NodeType[] = ['turn', 'material', 'chunk', 'concept']
const TYPE_LABEL: Record<NodeType, string> = {
  turn: 'Turns',
  material: 'Materials',
  chunk: 'Chunks',
  concept: 'Concepts',
}

/** Per-mode persistence key for the GraphPane filter state. */
const FILTER_KEY = (m: GraphMode) => `notesci_graph_filters_${m}`

const EMPTY_FILTERS: GraphFilters = {
  hiddenTypes: new Set(),
  minWeight: 0,
  query: '',
}

function loadFilters(mode: GraphMode): GraphFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY(mode))
    if (!raw) return EMPTY_FILTERS
    const parsed = JSON.parse(raw) as {
      hiddenTypes?: string[]
      minWeight?: number
      query?: string
    }
    return {
      hiddenTypes: new Set(
        (parsed.hiddenTypes ?? []).filter((t): t is NodeType =>
          (ALL_TYPES as string[]).includes(t),
        ),
      ),
      minWeight: Number.isFinite(parsed.minWeight) ? parsed.minWeight! : 0,
      query: typeof parsed.query === 'string' ? parsed.query : '',
    }
  } catch {
    return EMPTY_FILTERS
  }
}

function saveFilters(mode: GraphMode, f: GraphFilters) {
  try {
    localStorage.setItem(
      FILTER_KEY(mode),
      JSON.stringify({
        hiddenTypes: [...f.hiddenTypes],
        minWeight: f.minWeight,
        query: f.query,
      }),
    )
  } catch {
    /* quota / sandbox — survive silently */
  }
}

function isEmptyFilters(f: GraphFilters): boolean {
  return f.hiddenTypes.size === 0 && f.minWeight === 0 && f.query === ''
}

function applyFilters(graph: GraphOut, f: GraphFilters): GraphOut {
  if (isEmptyFilters(f)) return graph
  const q = f.query.trim().toLowerCase()
  const keep = (n: GraphNode): boolean => {
    if (f.hiddenTypes.has(n.type)) return false
    if (
      n.type === 'concept' &&
      f.minWeight > 0 &&
      (n.weight ?? 0) < f.minWeight
    )
      return false
    if (q && !(n.label ?? '').toLowerCase().includes(q)) return false
    return true
  }
  const keptIds = new Set(graph.nodes.filter(keep).map((n) => n.id))
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keptIds.has(n.id)),
    edges: graph.edges.filter(
      (e) => keptIds.has(e.source) && keptIds.has(e.target),
    ),
  }
}

const MODES: [GraphMode, string, string][] = [
  ['map', 'Map', 'Meta+0 Control+0'],
  ['citations', 'Citations', 'Meta+1 Control+1'],
  ['concepts', 'Concepts', 'Meta+2 Control+2'],
  ['reasoning', 'Reasoning', 'Meta+3 Control+3'],
]

interface GraphNode {
  id: string
  type: 'turn' | 'chunk' | 'material' | 'concept'
  label: string
  preview?: string | null
  weight?: number | null
  turn_seq?: number | null
}

interface GraphEdge {
  source: string
  target: string
  kind: 'citation' | 'provenance' | 'mention' | 'next'
}

interface GraphOut {
  mode: GraphMode
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Right pane: graph view with mode pill (Citations / Concepts /
 * Reasoning), legend chip bottom-left, mini-map bottom-right, zoom
 * controls top-right. Mirrors `GraphPane` from `ws-panes.jsx`.
 *
 * Backed by GET /sessions/{id}/graph?mode=... — returns the same
 * {nodes, edges} shape whether the user picks Citations or Concepts.
 * Reasoning adds `next` edges between consecutive turns.
 *
 * Mode is controlled by the host so keyboard shortcuts (⌘1/⌘2/⌘3) and
 * the in-pane pill stay in sync.
 */
export function GraphPane({
  sessionId,
  projectId,
  mode: modeProp,
  initialMode = 'map',
  onModeChange,
}: {
  sessionId: string | null
  projectId?: string | null
  mode?: GraphMode
  initialMode?: GraphMode
  onModeChange?: (mode: GraphMode) => void
}) {
  // `eventTick` increments whenever the host dispatches
  // `notesci-materials-changed`. Included in the fetch effect's deps
  // so the Map view re-fetches and a deleted file's node leaves the
  // canvas instead of lingering until the next manual mode switch.
  // Matches the existing window-event pattern (`notesci-auth-expired`,
  // `notesci-prefs-changed`) — saves threading a refresh prop through
  // every workspace render path.
  const [eventTick, setEventTick] = useState(0)
  useEffect(() => {
    const onChanged = () => setEventTick((t) => t + 1)
    window.addEventListener('notesci-materials-changed', onChanged)
    return () =>
      window.removeEventListener('notesci-materials-changed', onChanged)
  }, [])
  const [internalMode, setInternalMode] = useState<GraphMode>(initialMode)
  const mode = modeProp ?? internalMode
  const setMode = (m: GraphMode) => {
    if (modeProp === undefined) setInternalMode(m)
    onModeChange?.(m)
  }
  const [graph, setGraph] = useState<GraphOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const toast = useToast()
  const [reloadTick, setReloadTick] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  // Filter state — per-mode so swapping lenses doesn't carry stale
  // toggles. Persisted to localStorage so a researcher's "I always
  // hide chunks in citations view" preference survives reloads.
  const [filters, setFilters] = useState<GraphFilters>(() => loadFilters(mode))
  useEffect(() => {
    setFilters(loadFilters(mode))
  }, [mode])
  const updateFilters = (next: GraphFilters) => {
    setFilters(next)
    saveFilters(mode, next)
  }
  const [filterOpen, setFilterOpen] = useState(false)
  // Esc exits fullscreen.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullscreen])

  useEffect(() => {
    setError(null)
    // Map mode = project-wide materials view; doesn't need a session.
    // Other modes are session-scoped — empty graph until one exists.
    if (mode === 'map') {
      if (!projectId) {
        setGraph({ mode, nodes: [], edges: [] })
        return
      }
    } else if (!sessionId) {
      setGraph({ mode, nodes: [], edges: [] })
      return
    }
    setLoading(true)
    let aborted = false
    void (async () => {
      try {
        const url =
          mode === 'map'
            ? `/projects/${projectId}/map`
            : `/sessions/${sessionId}/graph?mode=${mode}`
        const res = await api<GraphOut>(url, { auth: true })
        if (!aborted) setGraph(res)
      } catch (err) {
        if (!aborted) {
          setError(errorMessage(err, "Couldn't load graph."))
        }
      } finally {
        if (!aborted) setLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [sessionId, projectId, mode, reloadTick, eventTick])

  return (
    <section
      aria-label="Graph"
      aria-busy={loading || undefined}
      className="pane"
      style={
        fullscreen
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: 60,
              background: 'var(--color-paper)',
              display: 'flex',
              flexDirection: 'column',
            }
          : { height: '100%', background: 'var(--color-paper)' }
      }
    >
      <div className="pane-header" style={{ gap: 8 }}>
        <span className="pane-title" style={{ flexShrink: 0 }}>GRAPH</span>
        <div
          role="tablist"
          aria-label="Graph view"
          style={{
            display: 'flex',
            padding: 3,
            background: 'var(--color-paper-2)',
            borderRadius: 9,
            border: '1px solid var(--color-rule)',
            boxShadow: 'inset 0 1px 0 rgba(14,17,22,0.025)',
          }}
        >
          {MODES.map(([id, label, shortcut]) => {
            const active = mode === id
            return (
              <button
                key={id}
                type="button"
                role="tab"
                onClick={() => setMode(id)}
                aria-selected={active}
                aria-label={label}
                aria-keyshortcuts={shortcut}
                style={{
                  padding: '4px 11px',
                  fontSize: 11.5,
                  borderRadius: 7,
                  border: 'none',
                  background: active ? 'var(--color-ink)' : 'transparent',
                  color: active ? 'var(--color-paper)' : 'var(--color-ink-2)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: active ? 500 : 400,
                  letterSpacing: -0.05,
                  boxShadow: active
                    ? '0 1px 0 rgba(14,17,22,0.06), 0 4px 10px -4px rgba(14,17,22,0.20)'
                    : undefined,
                  transition:
                    'background 180ms ease, color 180ms ease, box-shadow 180ms ease',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div
          role="toolbar"
          aria-label="Graph actions"
          style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}
        >
          <FilterButton
            mode={mode}
            graph={graph}
            filters={filters}
            onChange={updateFilters}
            open={filterOpen}
            onOpenChange={setFilterOpen}
          />
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => {
              setReloadTick((t) => t + 1)
              toast.success('Graph reloaded.')
            }}
            title="Reload the graph for this session"
            aria-label="Reload graph"
          >
            <Icons.reset size={12} />
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Expand graph to full screen'}
            aria-label={fullscreen ? 'Exit fullscreen graph' : 'Expand graph'}
            aria-pressed={fullscreen}
          >
            <Icons.arrowsOut size={12} />
          </button>
        </div>
      </div>
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'hidden',
          background: 'var(--color-paper-2)',
        }}
      >
        {(() => {
          if (!graph) {
            return (
              <EmptyOverlay
                mode={mode}
                hasSession={Boolean(sessionId)}
                error={error}
              />
            )
          }
          const filtered = applyFilters(graph, filters)
          if (filtered.nodes.length === 0) {
            const filteredOut = graph.nodes.length > 0
            return (
              <EmptyOverlay
                mode={mode}
                hasSession={Boolean(sessionId)}
                error={error}
                filteredOut={filteredOut}
                onClearFilters={
                  filteredOut ? () => updateFilters(EMPTY_FILTERS) : undefined
                }
              />
            )
          }
          return <GraphSvg graph={filtered} mode={mode} />
        })()}
        <Legend mode={mode} />
      </div>
    </section>
  )
}


function FilterButton({
  mode,
  graph,
  filters,
  onChange,
  open,
  onOpenChange,
}: {
  mode: GraphMode
  graph: GraphOut | null
  filters: GraphFilters
  onChange: (next: GraphFilters) => void
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  // Portal-anchored position: the popover lives at document.body so
  // `.pane-header { overflow: hidden }` can't clip it. We track the
  // trigger button's viewport rect and reposition on scroll / resize.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  )
  const activeCount =
    filters.hiddenTypes.size +
    (filters.minWeight > 0 ? 1 : 0) +
    (filters.query.trim() ? 1 : 0)

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const recompute = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setAnchor({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      })
    }
    recompute()
    window.addEventListener('resize', recompute)
    window.addEventListener('scroll', recompute, true)
    return () => {
      window.removeEventListener('resize', recompute)
      window.removeEventListener('scroll', recompute, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current && triggerRef.current.contains(t)) return
      if (popRef.current && popRef.current.contains(t)) return
      onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  // Only show toggles for node types that actually appear in the
  // current graph — hiding a type that isn't there would be confusing.
  const presentTypes = useMemo(() => {
    if (!graph) return new Set<NodeType>(ALL_TYPES)
    const s = new Set<NodeType>()
    for (const n of graph.nodes) s.add(n.type)
    return s
  }, [graph])

  // For the Map mode min-weight slider, find the max concept degree in
  // the graph so the slider's upper bound tracks the data.
  const maxConceptWeight = useMemo(() => {
    if (!graph || mode !== 'map') return 0
    let m = 0
    for (const n of graph.nodes) {
      if (n.type === 'concept' && typeof n.weight === 'number') {
        if (n.weight > m) m = n.weight
      }
    }
    return m
  }, [graph, mode])

  const toggleType = (t: NodeType) => {
    const next = new Set(filters.hiddenTypes)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    onChange({ ...filters, hiddenTypes: next })
  }

  const popover =
    open && anchor && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popRef}
            id={menuId}
            role="dialog"
            aria-label="Graph filters"
            style={{
              position: 'fixed',
              top: anchor.top,
              right: anchor.right,
              width: 280,
              background: '#fff',
              border: '1px solid var(--color-rule)',
              borderRadius: 12,
              boxShadow: '0 18px 36px -8px rgba(14,17,22,0.18)',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              zIndex: 100,
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
              Show
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ALL_TYPES.filter((t) => presentTypes.has(t)).map((t) => {
                const hidden = filters.hiddenTypes.has(t)
                return (
                  <button
                    key={t}
                    type="button"
                    className={`tag ${hidden ? '' : 'solid'}`}
                    style={{
                      cursor: 'pointer',
                      fontSize: 11,
                      opacity: hidden ? 0.55 : 1,
                    }}
                    onClick={() => toggleType(t)}
                    aria-pressed={!hidden}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                )
              })}
              {[...filters.hiddenTypes]
                .filter((t) => !presentTypes.has(t))
                .map((t) => (
                  <span
                    key={t}
                    className="tag"
                    style={{ fontSize: 11, opacity: 0.4 }}
                    title="No nodes of this type in the current graph"
                  >
                    {TYPE_LABEL[t]}
                  </span>
                ))}
            </div>

            {mode === 'map' && maxConceptWeight > 1 && (
              <>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.1em',
                    color: 'var(--color-muted)',
                    textTransform: 'uppercase',
                    marginTop: 4,
                  }}
                >
                  Min concept hub
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="range"
                    min={0}
                    max={maxConceptWeight}
                    step={1}
                    value={Math.min(filters.minWeight, maxConceptWeight)}
                    onChange={(e) =>
                      onChange({
                        ...filters,
                        minWeight: Number(e.target.value),
                      })
                    }
                    style={{ flex: 1, accentColor: 'var(--color-indigo)' }}
                    aria-label="Minimum concept-hub degree"
                  />
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--color-ink-2)',
                      width: 28,
                      textAlign: 'right',
                    }}
                  >
                    ≥ {filters.minWeight}
                  </span>
                </div>
              </>
            )}

            <div
              className="font-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.1em',
                color: 'var(--color-muted)',
                textTransform: 'uppercase',
                marginTop: 4,
              }}
            >
              Search label
            </div>
            <input
              type="search"
              className="ns-input"
              placeholder="title or concept…"
              value={filters.query}
              onChange={(e) => onChange({ ...filters, query: e.target.value })}
              style={{ fontSize: 12.5, padding: '6px 10px', height: 32 }}
              aria-label="Filter graph nodes by label"
            />

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 4,
                gap: 8,
              }}
            >
              <button
                type="button"
                className="ns-btn ghost tiny"
                disabled={isEmptyFilters(filters)}
                onClick={() => onChange(EMPTY_FILTERS)}
                style={{ fontSize: 11 }}
              >
                Reset
              </button>
              <button
                type="button"
                className="ns-btn tiny"
                onClick={() => onOpenChange(false)}
                style={{ fontSize: 11 }}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ns-btn ghost tiny"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={
          activeCount > 0
            ? `Filter graph (${activeCount} active)`
            : 'Filter graph'
        }
        title={
          activeCount > 0
            ? `Filter graph · ${activeCount} active`
            : 'Filter the graph'
        }
        style={{
          position: 'relative',
          // Hint the visual state so the icon-only trigger doesn't fade
          // into the rest of the toolbar when filters are live.
          color:
            activeCount > 0 ? 'var(--color-indigo)' : 'var(--color-ink-2)',
        }}
      >
        <Icons.filter size={13} />
        {activeCount > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -3,
              right: -3,
              minWidth: 14,
              height: 14,
              padding: '0 3px',
              borderRadius: 999,
              background: 'var(--color-indigo)',
              color: '#fff',
              fontSize: 9,
              fontWeight: 700,
              lineHeight: '14px',
              textAlign: 'center',
              boxShadow: '0 0 0 1.5px var(--color-paper)',
            }}
          >
            {activeCount}
          </span>
        )}
      </button>
      {popover}
    </>
  )
}

function EmptyOverlay({
  mode,
  hasSession,
  error,
  filteredOut,
  onClearFilters,
}: {
  mode: GraphMode
  hasSession: boolean
  error: string | null
  filteredOut?: boolean
  onClearFilters?: () => void
}) {
  // Per-state copy: a one-line eyebrow tag + a short, calm paragraph.
  // Editorial tone instead of "no results yet :(" — matches the rest
  // of the workspace chrome.
  let eyebrow = ''
  let body = ''
  if (error) {
    eyebrow = 'Couldn’t load'
    body = error
  } else if (filteredOut) {
    eyebrow = 'Filtered out'
    body = 'Every node was hidden by the current filter. Loosen it to see results.'
  } else if (mode === 'map') {
    eyebrow = 'Project map'
    body = 'Ingest some materials and the project-wide wiki map will populate here.'
  } else if (!hasSession) {
    eyebrow = 'No session yet'
    body = 'Start a chat to see its graph here.'
  } else if (mode === 'citations') {
    eyebrow = 'No citations yet'
    body = 'Ask the agent something about your sources, and the citations it pulls will appear here.'
  } else if (mode === 'concepts') {
    eyebrow = 'No concepts yet'
    body = 'Concepts are extracted from cited materials. Add some sources and ask a question.'
  } else {
    eyebrow = 'No reasoning trail yet'
    body = "The reasoning lens lights up once the agent's answers cite multiple sources across turns."
  }
  return (
    <div
      role={error ? 'alert' : 'status'}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
        color: 'var(--color-muted)',
        fontSize: 13,
        lineHeight: 1.6,
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        aria-hidden
        className="font-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.14em',
          color: error ? 'var(--color-error)' : 'var(--color-muted)',
          textTransform: 'uppercase',
          opacity: error ? 0.85 : 0.7,
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          maxWidth: 340,
          color: error ? 'var(--color-ink-2)' : 'var(--color-ink-2)',
          fontFamily: "'Source Serif 4', Georgia, serif",
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        {body}
      </div>
      {filteredOut && onClearFilters && (
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={onClearFilters}
          style={{ fontSize: 11.5 }}
        >
          Reset filters
        </button>
      )}
    </div>
  )
}

// Per-mode legend copy + swatches lifted from the handoff's
// `ws-graph-spotlight.jsx` GRAPH_COPY map.
const LEGENDS: Record<
  GraphMode,
  { caption: string; rows: { label: string; color: string }[] }
> = {
  map: {
    caption: 'PROJECT-WIDE MATERIALS MAP',
    rows: [
      { label: 'material (paper, PDF, URL, note)', color: '#fff' },
      { label: 'shared concept (links related materials)', color: 'var(--color-indigo)' },
    ],
  },
  citations: {
    caption: 'WHO CITES WHOM',
    rows: [
      { label: 'referenced by latest answer', color: 'var(--color-indigo)' },
      { label: 'draft / note', color: 'var(--color-warn)' },
      { label: 'everything else', color: 'var(--color-rule-2)' },
    ],
  },
  concepts: {
    caption: 'EXTRACTED CONCEPTS',
    rows: [
      { label: 'concept', color: 'var(--color-indigo)' },
      { label: 'co-occurrence link', color: 'var(--color-rule-2)' },
    ],
  },
  reasoning: {
    caption: 'AGENT REASONING TRAIL',
    rows: [
      { label: 'your question / turn', color: 'var(--color-ink)' },
      { label: 'agent step → next', color: 'var(--color-paper-2)' },
      { label: 'source consulted', color: 'var(--color-indigo)' },
      { label: 'final answer', color: 'var(--color-teal)' },
    ],
  },
}

function Legend({ mode }: { mode: GraphMode }) {
  const l = LEGENDS[mode]
  return (
    <div
      role="group"
      aria-label={`${l.caption} legend`}
      style={{
        position: 'absolute',
        left: 14,
        bottom: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        background: '#fff',
        // Layered shadow + hairline rule matches the node treatment so
        // the legend reads as part of the same visual system rather
        // than a flat chip pasted on top.
        border: '1px solid var(--color-rule)',
        borderRadius: 10,
        padding: '10px 12px 11px',
        fontSize: 11.5,
        color: 'var(--color-ink-2)',
        lineHeight: 1.4,
        boxShadow:
          '0 1px 0 rgba(14,17,22,0.04), 0 6px 18px -8px rgba(14,17,22,0.12)',
        backdropFilter: 'saturate(110%)',
      }}
    >
      <div
        aria-hidden
        className="font-mono"
        style={{
          fontSize: 9.5,
          color: 'var(--color-muted)',
          letterSpacing: '0.1em',
          marginBottom: 1,
        }}
      >
        {l.caption}
      </div>
      {l.rows.map((r) => (
        <div
          key={r.label}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 5,
              background: r.color,
              boxShadow:
                r.color === 'var(--color-indigo)'
                  ? '0 0 0 2px color-mix(in oklch, var(--color-indigo) 18%, transparent)'
                  : undefined,
              border:
                r.color === 'var(--color-paper-2)' || r.color === '#fff'
                  ? '1px solid var(--color-rule-2)'
                  : 'none',
            }}
          />
          <span style={{ letterSpacing: -0.05 }}>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Interactive graph view with a small in-browser force simulation,
 * mouse hover details, click-to-pin, and wheel zoom + drag pan.
 *
 * The simulation is a deterministic Verlet-style relaxation seeded from
 * a polar layout (so empty / freshly-loaded graphs always render in
 * the same place). It runs synchronously in `useMemo` keyed on the
 * graph payload, so identical graphs reuse the same positions across
 * re-renders.
 *
 * Why hand-rolled instead of d3-force / cytoscape: those libs add ~150 KB
 * gzipped. With our typical scale (≤50 nodes per session graph) a 200-
 * iteration relaxation is <5 ms in modern V8 — well under the 16 ms
 * frame budget — and there's no dependency to ship.
 */
function GraphSvg({ graph, mode }: { graph: GraphOut; mode: GraphMode }) {
  // Map mode is project-wide and typically has many materials, so we
  // give it more canvas room — the simulation seeds against this
  // viewport size, and a bigger field means cleaner separation between
  // hubs and leaves. Stretch wider when there are many nodes so the
  // anti-collision pass has space to fan out instead of compressing
  // into a tight ball.
  const dynamic = mode === 'map' ? Math.max(0, graph.nodes.length - 16) * 18 : 0
  const W = (mode === 'map' ? 1240 : 800) + dynamic
  const H = (mode === 'map' ? 820 : 600) + Math.round(dynamic * 0.7)

  const layout = useMemo(() => {
    // simulate() does fairly involved Map/array manipulation against
    // server-supplied graph data. If a malformed payload sneaks through,
    // we'd rather degrade to an empty layout than crash — the local
    // GraphErrorBoundary still catches anything that escapes downstream.
    try {
      return simulate(graph, W, H, mode)
    } catch (err) {
      console.warn('graph simulate failed', err)
      return new Map<string, { x: number; y: number }>()
    }
  }, [graph, W, H, mode])

  // Compute a fit-to-content viewBox so the rendered cluster fills the
  // SVG regardless of how dense or sparse the graph is. We then clamp
  // it to a minimum size matching the canvas dimensions so a tiny
  // graph (3-4 nodes) doesn't make labels appear oversized — those
  // labels are sized in viewBox units, so a small viewBox = big text.
  const fit = useMemo(() => {
    if (layout.size === 0) return { x: 0, y: 0, w: W, h: H }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of layout.values()) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    // Tighter padding so the cluster fills the viewport instead of
    // floating in margin (the previous 100/80 left a noticeable
    // dead-zone band on dense maps). Bottom pad is bumped to 88 so
    // the legend chip in the bottom-left doesn't sit on top of nodes.
    const padX = 60
    const padTop = 48
    const padBottom = 88
    // Use the canvas dimensions as the floor — keeps text proportions
    // sensible for sparse graphs while still framing dense ones tightly.
    const contentW = maxX - minX + padX * 2
    const contentH = maxY - minY + padTop + padBottom
    const w = Math.max(W, contentW)
    const h = Math.max(H, contentH)
    // Centre the cluster inside the viewBox horizontally; vertically
    // bias it up by half the asymmetric pad so the legend stays clear.
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2 + (padBottom - padTop) / 2
    return { x: cx - w / 2, y: cy - h / 2, w, h }
  }, [layout])

  // Pan + zoom — pure SVG viewBox manipulation. Keeps the geometry
  // identical to the static render (hit-testing works), and sidesteps
  // the antialiasing artefacts you get from CSS transform: scale().
  const [view, setView] = useState(fit)
  useEffect(() => {
    setView(fit)
  }, [fit])

  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragging = useRef<{ x: number; y: number } | null>(null)

  // Convert a pointer event to viewBox-space coords so wheel-zoom can
  // anchor on the cursor (zoom in toward what you're pointing at).
  const pointerToView = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const fx = (clientX - rect.left) / rect.width
    const fy = (clientY - rect.top) / rect.height
    return { x: view.x + fx * view.w, y: view.y + fy * view.h }
  }

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.12 : 0.89
    const anchor = pointerToView(e.clientX, e.clientY)
    const newW = Math.min(fit.w * 5, Math.max(fit.w * 0.2, view.w * factor))
    const newH = Math.min(fit.h * 5, Math.max(fit.h * 0.2, view.h * factor))
    setView({
      x: anchor.x - ((anchor.x - view.x) * newW) / view.w,
      y: anchor.y - ((anchor.y - view.y) * newH) / view.h,
      w: newW,
      h: newH,
    })
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('[data-node]')) return
    dragging.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const dx = ((e.clientX - dragging.current.x) / rect.width) * view.w
    const dy = ((e.clientY - dragging.current.y) / rect.height) * view.h
    setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
    dragging.current = { x: e.clientX, y: e.clientY }
  }

  const onPointerUp = () => {
    dragging.current = null
  }

  const [hover, setHover] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  // Hovered edge index — drives the per-edge highlight. Separate from
  // node hover so mousing along a link lights up just that connection.
  const [hoverEdge, setHoverEdge] = useState<number | null>(null)
  const focused = pinned ?? hover

  const focusedNode = focused
    ? graph.nodes.find((n) => n.id === focused) ?? null
    : null

  // Pre-compute neighbour set for highlight emphasis when a node is
  // focused (hover or pin). All other nodes/edges fade to ~25%.
  const neighbours = useMemo(() => {
    if (!focused) return null
    const ns = new Set<string>([focused])
    for (const e of graph.edges) {
      if (e.source === focused) ns.add(e.target)
      if (e.target === focused) ns.add(e.source)
    }
    return ns
  }, [graph, focused])

  // Per-pair edge fan-out — only bow when multiple edges share the same
  // unordered endpoints. Solo edges stay straight (premium feel: a
  // single, deliberate line). Pairs/trios fan out symmetrically so the
  // family looks intentional, not noisy.
  const edgeFan = useMemo(() => {
    const fan = new Map<string, { idx: number; total: number }>()
    const byPair = new Map<string, number[]>()
    graph.edges.forEach((e, i) => {
      const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
      const arr = byPair.get(key)
      if (arr) arr.push(i)
      else byPair.set(key, [i])
    })
    for (const arr of byPair.values()) {
      arr.forEach((idx, k) => fan.set(String(idx), { idx: k, total: arr.length }))
    }
    return fan
  }, [graph])

  return (
    <>
      <svg
        ref={svgRef}
        // Key on (mode + node count) so a mode switch or significant
        // data change remounts the SVG and re-runs the entry fade —
        // cheap, no animation lib, and the canvas doesn't snap.
        key={`${mode}-${graph.nodes.length}-${graph.edges.length}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        width="100%"
        height="100%"
        className="ws-graph-canvas"
        style={{
          display: 'block',
          cursor: dragging.current ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
        role="img"
        aria-label={`Graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges. Scroll to zoom, drag to pan, double-click to reset view.`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => {
          // Click on background unpins.
          if (!(e.target as Element).closest('[data-node]')) setPinned(null)
        }}
        onDoubleClick={(e) => {
          // Double-click on the background snaps the view back to the
          // fit-to-content rect. Lets a user recover from over-zooming
          // without hunting for a toolbar button.
          if (!(e.target as Element).closest('[data-node]')) setView(fit)
        }}
      >
        <defs>
          {/* Fine paper-grain — staggered dot pattern (every other row
              offset by half the cadence) reads as organic texture
              instead of a graph-paper grid. Two slightly different
              opacities give the surface micro-variation. */}
          <pattern id="ws-grid" width="32" height="32" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r=".5" fill="var(--color-ink)" opacity=".055" />
            <circle cx="18" cy="2" r=".4" fill="var(--color-ink)" opacity=".035" />
            <circle cx="10" cy="18" r=".5" fill="var(--color-ink)" opacity=".05" />
            <circle cx="26" cy="18" r=".4" fill="var(--color-ink)" opacity=".035" />
          </pattern>
          {/* Vignette mask — fades the dot field toward the edges so the
              cluster sits on its own pool of paper. Big radius keeps
              the centre fully visible at any zoom level. */}
          <radialGradient id="ws-vignette" cx="0.5" cy="0.5" r="0.62">
            <stop offset="0%" stopColor="#000" stopOpacity="1" />
            <stop offset="70%" stopColor="#000" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <mask id="ws-grid-mask">
            <rect x="-50%" y="-50%" width="200%" height="200%" fill="url(#ws-vignette)" />
          </mask>
          {/* Two-layer drop shadow: a tight, dark ambient (0.22 / dy 1)
              plus a wider, softer cast (0.10 / dy 5) — the same trick
              high-quality design systems use for that "lifted off the
              page" feel without going cartoonish. */}
          <filter id="ws-node-shadow" x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.2" floodColor="#0e1116" floodOpacity="0.22" />
            <feDropShadow dx="0" dy="5" stdDeviation="6" floodColor="#0e1116" floodOpacity="0.10" />
          </filter>
          <filter id="ws-hub-shadow" x="-80%" y="-80%" width="260%" height="260%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.4" floodColor="#0e1116" floodOpacity="0.22" />
            <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="oklch(0.52 0.22 274)" floodOpacity="0.30" />
          </filter>
          {/* Hub fill: deeper indigo at the top-left highlight,
              richer indigo toward the rim — reads as a small enamel
              token rather than a flat circle. */}
          <radialGradient id="ws-hub-fill" cx="0.38" cy="0.34" r="0.78">
            <stop offset="0%" stopColor="color-mix(in oklch, var(--color-indigo) 8%, white)" />
            <stop offset="50%" stopColor="color-mix(in oklch, var(--color-indigo) 22%, white)" />
            <stop offset="100%" stopColor="color-mix(in oklch, var(--color-indigo) 38%, white)" />
          </radialGradient>
          {/* Material fill: ivory highlight settling into warm paper —
              reads like a small disc of stock against the field. */}
          <radialGradient id="ws-material-fill" cx="0.4" cy="0.32" r="0.85">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="55%" stopColor="color-mix(in oklch, var(--color-paper) 35%, #ffffff)" />
            <stop offset="100%" stopColor="color-mix(in oklch, var(--color-paper) 80%, #ffffff)" />
          </radialGradient>
          {/* Per-edge fade so non-citation links read as quiet links
              rather than dominating the layout. Applied via stroke. */}
          <linearGradient id="ws-edge-soft" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-indigo)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-indigo)" stopOpacity="0.42" />
          </linearGradient>
          <marker
            id="arrow-mention"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-teal)" />
          </marker>
          <marker
            id="arrow-next"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-indigo)" />
          </marker>
        </defs>
        <rect
          x={view.x - fit.w}
          y={view.y - fit.h}
          width={view.w + 2 * fit.w}
          height={view.h + 2 * fit.h}
          fill="url(#ws-grid)"
          mask="url(#ws-grid-mask)"
        />

        {graph.edges.map((e, i) => {
          const A = layout.get(e.source)
          const B = layout.get(e.target)
          if (!A || !B) return null
          const inFocus = !neighbours
            || (neighbours.has(e.source) && neighbours.has(e.target))
          // "Traced" edges are those touching the focused node — when
          // a user hovers/pins a node, its incident edges trace out in
          // brand indigo so the connection reads as a path, not just a
          // brightening of the existing line.
          const traced = !!neighbours && inFocus
          const baseStroke =
            e.kind === 'next'
              ? 'var(--color-indigo)'
              : e.kind === 'mention'
                ? 'var(--color-teal)'
                : mode === 'map'
                  ? 'color-mix(in oklch, var(--color-indigo) 32%, var(--color-rule-2))'
                  : 'var(--color-rule-2)'
          const stroke = traced && e.kind !== 'mention'
            ? 'var(--color-indigo)'
            : baseStroke
          const dash = e.kind === 'next' ? '5 3' : undefined
          const marker =
            e.kind === 'next'
              ? 'url(#arrow-next)'
              : e.kind === 'mention'
                ? 'url(#arrow-mention)'
                : undefined
          // Trim the line short of the target circle so the arrowhead
          // doesn't bury the node outline.
          const targetR = nodeRadius(graph.nodes.find((n) => n.id === e.target))
          const sourceR = nodeRadius(graph.nodes.find((n) => n.id === e.source))
          const dx = B.x - A.x
          const dy = B.y - A.y
          const dist = Math.hypot(dx, dy) || 1
          const nx = dx / dist
          const ny = dy / dist
          const sx = A.x + nx * (sourceR + 1)
          const sy = A.y + ny * (sourceR + 1)
          const tx = B.x - nx * (targetR + 2)
          const ty = B.y - ny * (targetR + 2)
          // Only bow when this pair has multiple edges to fan out — a
          // solo edge stays straight, which reads as deliberate rather
          // than hand-drawn. Fanned edges are spread symmetrically
          // about the chord (e.g. 3 edges → offsets -1, 0, +1).
          const fan = edgeFan.get(String(i))
          let bow = 0
          if (fan && fan.total > 1) {
            const span = Math.min(22, dist * 0.10)
            const slot = fan.idx - (fan.total - 1) / 2
            bow = span * slot
          }
          const mx = (sx + tx) / 2 - ny * bow
          const my = (sy + ty) / 2 + nx * bow
          const d =
            bow === 0
              ? `M ${sx} ${sy} L ${tx} ${ty}`
              : `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`
          const edgeHovered = hoverEdge === i
          return (
            <g key={i}>
              {/* Wide transparent hit-path — a 1px stroke is nearly
                  impossible to hover precisely, so we lay an invisible
                  10px-wide path over it to catch the pointer. */}
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                strokeLinecap="round"
                style={{ cursor: 'pointer' }}
                onPointerEnter={() => setHoverEdge(i)}
                onPointerLeave={() =>
                  setHoverEdge((cur) => (cur === i ? null : cur))
                }
              />
              <path
                d={d}
                fill="none"
                stroke={edgeHovered ? 'var(--color-indigo)' : stroke}
                strokeWidth={
                  edgeHovered
                    ? (mode === 'map' ? 2.2 : 2.4)
                    : traced
                      ? (mode === 'map' ? 1.8 : 2.0)
                      : mode === 'map' ? (inFocus ? 1.25 : 0.9) : 1.4
                }
                strokeDasharray={dash}
                strokeLinecap="round"
                opacity={
                  edgeHovered
                    ? 0.95
                    : traced
                      ? 0.85
                      : inFocus
                        ? (mode === 'map' ? 0.55 : 0.78)
                        : 0.12
                }
                markerEnd={marker}
                pointerEvents="none"
                style={{
                  transition:
                    'opacity 160ms ease, stroke-width 160ms ease, stroke 160ms ease',
                }}
              />
            </g>
          )
        })}

        {graph.nodes.map((n) => {
          const p = layout.get(n.id)
          if (!p) return null
          const r = nodeRadius(n)
          const inFocus = !neighbours || neighbours.has(n.id)
          const isFocus = focused === n.id

          const palette = nodePalette(n)
          // Concepts with high weight in Map mode are "hubs" — draw
          // them larger, with a richer gradient + halo so they read as
          // anchors of the wiki map rather than yet another leaf.
          const isHub =
            mode === 'map' &&
            n.type === 'concept' &&
            (n.weight ?? 0) >= 3
          const fill =
            n.type === 'concept' && (isHub || mode === 'map')
              ? 'url(#ws-hub-fill)'
              : n.type === 'material'
                ? 'url(#ws-material-fill)'
                : palette.bg
          const useShadow = mode === 'map' && (n.type === 'material' || n.type === 'concept')
          const showLabel = n.type === 'material' || n.type === 'concept'
          const labelText = showLabel ? truncate(n.label, 26) : ''
          const labelWidth = labelText.length * 6.0 + 12
          const nodeKindLabel =
            n.type === 'turn'
              ? 'turn'
              : n.type === 'chunk'
                ? 'chunk'
                : n.type
          return (
            <g
              key={n.id}
              data-node={n.id}
              className="ws-graph-node"
              transform={`translate(${p.x},${p.y})`}
              opacity={inFocus ? 1 : 0.3}
              style={{
                cursor: 'pointer',
                // Smooth the focus/blur cross-fade so dragging hover
                // between nodes doesn't strobe the canvas.
                transition: 'opacity 200ms ease',
              }}
              // Keyboard access: nodes are now Tab-reachable. Focusing a
              // node mirrors hover (shows the DetailCard + traces edges);
              // Enter/Space pins it, Escape clears the pin. This makes
              // the whole graph operable without a mouse.
              tabIndex={0}
              role="button"
              aria-label={`${nodeKindLabel}: ${n.label || 'untitled'}${
                pinned === n.id ? ' (pinned)' : ''
              }`}
              aria-pressed={pinned === n.id}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover((cur) => (cur === n.id ? null : cur))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setPinned((cur) => (cur === n.id ? null : n.id))
                } else if (e.key === 'Escape' && pinned === n.id) {
                  e.preventDefault()
                  setPinned(null)
                }
              }}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover(null)}
              onClick={(e) => {
                e.stopPropagation()
                setPinned((cur) => (cur === n.id ? null : n.id))
              }}
            >
              {isFocus && (
                <>
                  {/* Outer soft glow — replaces the elementary dashed
                      ring with a two-layer indigo halo (wide soft +
                      tight crisp) that reads as a tasteful focus
                      state, not a marching-ants selection. */}
                  <circle
                    r={r + 14}
                    fill="var(--color-indigo)"
                    opacity={0.07}
                  />
                  <circle
                    r={r + 8}
                    fill="var(--color-indigo)"
                    opacity={0.12}
                  />
                  <circle
                    r={r + 3.5}
                    fill="none"
                    stroke="var(--color-indigo)"
                    strokeWidth={1.25}
                    opacity={0.55}
                  />
                </>
              )}
              {isHub && !isFocus && (
                <>
                  {/* Two-layer halo so hub concepts read as anchors:
                      a wide diffuse ring + a tighter, slightly stronger
                      bloom right at the rim. Same trick as the focus
                      halo but quieter so it doesn't compete. */}
                  <circle r={r + 9} fill="var(--color-indigo)" opacity={0.04} />
                  <circle r={r + 4} fill="var(--color-indigo)" opacity={0.10} />
                </>
              )}
              <circle
                r={r}
                fill={fill}
                stroke={palette.stroke}
                strokeWidth={isFocus ? 2 : isHub ? 1.6 : 1.3}
                filter={
                  useShadow
                    ? isHub
                      ? 'url(#ws-hub-shadow)'
                      : 'url(#ws-node-shadow)'
                    : undefined
                }
              />
              {/* Inner glyph or count. Hub concepts show their degree so
                  the visual weight matches their importance at a glance;
                  materials get a tiny "page lines" mark so they read as
                  a document on the wiki map; turns/chunks render their
                  short tag as before. */}
              {n.type === 'material' && mode === 'map' && (
                <g
                  pointerEvents="none"
                  stroke="var(--color-muted)"
                  strokeWidth={1.1}
                  strokeLinecap="round"
                  opacity={0.6}
                >
                  <line x1={-6} y1={-3.5} x2={6} y2={-3.5} />
                  <line x1={-6} y1={0} x2={6} y2={0} />
                  <line x1={-6} y1={3.5} x2={3} y2={3.5} />
                </g>
              )}
              {isHub && (
                <text
                  y={4}
                  textAnchor="middle"
                  fontSize={11}
                  fontFamily="JetBrains Mono"
                  fontWeight={700}
                  fill="var(--color-indigo)"
                  pointerEvents="none"
                  letterSpacing={-0.2}
                >
                  {n.weight ?? ''}
                </text>
              )}
              {(n.type === 'turn' || n.type === 'chunk') && (
                <text
                  y={4}
                  textAnchor="middle"
                  fontSize={11}
                  fontFamily="JetBrains Mono"
                  fontWeight={600}
                  fill={palette.fg}
                  pointerEvents="none"
                >
                  {n.type === 'turn'
                    ? `T${(n.turn_seq ?? 0) + 1}`
                    : n.label}
                </text>
              )}
              {showLabel && (
                <g pointerEvents="none">
                  {/* Label background pill — paper fill + hairline rule
                      so adjacent pills don't blend if the layout still
                      leaves them close, and the label reads as a chip
                      above the dotted grid + edges. */}
                  <rect
                    x={-labelWidth / 2}
                    y={r + 7}
                    width={labelWidth}
                    height={19}
                    rx={9.5}
                    ry={9.5}
                    fill="var(--color-paper)"
                    stroke="var(--color-rule)"
                    strokeWidth={0.75}
                    opacity={mode === 'map' ? 0.96 : 0.88}
                  />
                  <text
                    y={r + 20}
                    textAnchor="middle"
                    fontSize={10.5}
                    fontFamily="'Inter Tight', system-ui, sans-serif"
                    fontWeight={n.type === 'concept' && isHub ? 600 : 500}
                    fill={
                      n.type === 'concept'
                        ? 'var(--color-indigo)'
                        : 'var(--color-ink)'
                    }
                    letterSpacing={-0.1}
                  >
                    {labelText}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
      <DetailCard node={focusedNode} pinned={!!pinned && !!focusedNode} />
      <ZoomBadge view={view} fit={fit} onReset={() => setView(fit)} />
    </>
  )
}

/**
 * Bottom-right zoom indicator. Only appears once the user has zoomed
 * or panned away from the fit-to-content rect — at rest the canvas
 * stays clean. Clicking it (or pressing Enter/Space) snaps back to
 * fit, the same action as double-clicking the background, but
 * discoverable instead of hidden.
 */
function ZoomBadge({
  view,
  fit,
  onReset,
}: {
  view: { x: number; y: number; w: number; h: number }
  fit: { x: number; y: number; w: number; h: number }
  onReset: () => void
}) {
  const zoom = fit.w / view.w
  // "At rest" = same zoom AND same centre as fit (within a small
  // tolerance for float drift). Hide the badge then.
  const sameZoom = Math.abs(zoom - 1) < 0.02
  const samePan =
    Math.abs(view.x + view.w / 2 - (fit.x + fit.w / 2)) < 2 &&
    Math.abs(view.y + view.h / 2 - (fit.y + fit.h / 2)) < 2
  if (sameZoom && samePan) return null
  const pct = Math.round(zoom * 100)
  return (
    <button
      type="button"
      onClick={onReset}
      aria-label={`Zoom ${pct} percent — reset to fit`}
      title="Reset view to fit"
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 9px',
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 8,
        boxShadow:
          '0 1px 0 rgba(14,17,22,0.04), 0 6px 16px -8px rgba(14,17,22,0.16)',
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--color-ink-2)',
        letterSpacing: '0.04em',
      }}
    >
      <span>{pct}%</span>
      <span
        aria-hidden
        style={{
          width: 1,
          height: 10,
          background: 'var(--color-rule)',
        }}
      />
      <Icons.reset size={11} />
    </button>
  )
}


function nodeRadius(n: GraphNode | undefined): number {
  if (!n) return 14
  // Concept hubs scale with degree but cap at 32 so a single 10-link
  // concept doesn't dominate the canvas.
  return n.type === 'concept'
    ? Math.max(16, Math.min(32, 14 + Math.min(18, (n.weight ?? 1) * 3.2)))
    : n.type === 'turn'
      ? 26
      : n.type === 'material'
        ? 22
        : 14
}


function nodePalette(n: GraphNode) {
  switch (n.type) {
    case 'turn':
      return {
        bg: 'var(--color-ink)',
        stroke: 'var(--color-ink)',
        fg: 'var(--color-paper)',
      }
    case 'material':
      return {
        bg: '#fff',
        stroke: 'var(--color-rule-2)',
        fg: 'var(--color-ink)',
      }
    case 'concept':
      return {
        bg: 'color-mix(in oklch, var(--color-indigo) 14%, white)',
        stroke: 'var(--color-indigo)',
        fg: 'var(--color-indigo)',
      }
    default: // chunk
      return {
        bg: 'color-mix(in oklch, var(--color-teal) 18%, white)',
        stroke: 'var(--color-teal)',
        fg: 'var(--color-ink)',
      }
  }
}


function DetailCard({
  node,
  pinned,
}: {
  node: GraphNode | null
  pinned: boolean
}) {
  if (!node) return null
  const typeLabel: Record<GraphNode['type'], string> = {
    turn: 'Turn',
    chunk: 'Chunk',
    material: 'Material',
    concept: 'Concept',
  }
  return (
    <div
      role="dialog"
      aria-label={`${typeLabel[node.type]} details`}
      style={{
        position: 'absolute',
        right: 14,
        top: 14,
        maxWidth: 280,
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 12,
        padding: '12px 14px',
        boxShadow: pinned
          ? '0 1px 0 rgba(14,17,22,0.04), 0 12px 32px -8px rgba(14,17,22,0.18)'
          : '0 1px 0 rgba(14,17,22,0.04), 0 8px 20px -6px rgba(14,17,22,0.12)',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--color-ink-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        pointerEvents: 'none',
        transition: 'box-shadow 200ms ease',
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.08em',
          color: 'var(--color-muted)',
          textTransform: 'uppercase',
        }}
      >
        {typeLabel[node.type]}
        {pinned && ' · pinned'}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--color-ink)',
        }}
      >
        {node.label || '(untitled)'}
      </div>
      {node.preview && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--color-ink-2)',
            lineHeight: 1.5,
            maxHeight: 110,
            overflow: 'hidden',
          }}
        >
          {node.preview}
        </div>
      )}
      {node.weight !== undefined && node.weight !== null && (
        <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--color-muted)' }}>
          weight: {node.weight}
        </div>
      )}
    </div>
  )
}


function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}


/**
 * Verlet-style force simulation, mode-aware.
 *
 * Forces (all modes):
 *   1. repulsion — every node pushes every other away (Coulomb-ish, 1/r^2)
 *   2. spring   — connected nodes pull toward an ideal edge length
 *   3. centring — weak pull toward the canvas centre so disconnected
 *                 components don't drift off-screen
 *
 * For Map mode we use a "concept hub" seed: concepts are placed on an
 * inner ring proportional to their degree, materials hang on an outer
 * ring around the concepts they cite. Force constants are stronger so
 * label-sized nodes don't crowd each other.
 *
 * After the main relaxation we run a short **anti-collision pass** that
 * inflates each node by its approximate label width and pushes any
 * pair whose bounding circles overlap. This is what turns the old
 * "clump" rendering into a clean network.
 */
function simulate(
  graph: GraphOut,
  W: number,
  H: number,
  mode: GraphMode,
): Map<string, { x: number; y: number }> {
  const nodes = graph.nodes
  const N = nodes.length
  if (N === 0) return new Map()

  const cx = W / 2
  const cy = H / 2

  const turns = nodes.filter((n) => n.type === 'turn')
  const materials = nodes.filter((n) => n.type === 'material')
  const chunks = nodes.filter((n) => n.type === 'chunk')
  const concepts = nodes.filter((n) => n.type === 'concept')

  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>()

  const placeRow = (group: GraphNode[], y: number) => {
    group.forEach((n, i) => {
      const x = group.length === 1
        ? cx
        : 100 + (i * (W - 200)) / Math.max(1, group.length - 1)
      pos.set(n.id, { x, y, vx: 0, vy: 0 })
    })
  }
  const placeRing = (group: GraphNode[], radius: number, phase = 0) => {
    group.forEach((n, i) => {
      const angle = (i / Math.max(1, group.length)) * Math.PI * 2 + phase
      pos.set(n.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      })
    })
  }

  if (mode === 'map') {
    // Bipartite seed: concepts on an inner ring, materials on the outer
    // ring positioned near their highest-degree concept. Heavier
    // concepts (more incident edges) come first on the ring so the
    // visual rhythm matches the data — the relaxation then polishes a
    // sane structure rather than untangling a pile.
    const conceptsRanked = [...concepts].sort(
      (a, b) => (b.weight ?? 0) - (a.weight ?? 0),
    )
    const conceptRadius =
      Math.min(W, H) * 0.16 + Math.min(140, conceptsRanked.length * 12)
    // Material ring sits *outside* the concept ring with a margin that
    // grows with material count — guarantees the two rings don't
    // collapse onto each other on dense projects (the old fixed
    // proportion broke as soon as concepts ≥ ~10).
    const materialRadius =
      conceptRadius + Math.max(170, materials.length * 6) + 40
    placeRing(conceptsRanked, conceptRadius, -Math.PI / 2)

    // Index: for each material, which concept does it bridge to? (May
    // be several — use the first edge match for seeding.)
    const conceptIndex = new Map<string, number>()
    conceptsRanked.forEach((c, i) => conceptIndex.set(c.id, i))
    const incidentConcept = new Map<string, number>()
    for (const e of graph.edges) {
      const ci = conceptIndex.get(e.source) ?? conceptIndex.get(e.target)
      if (ci === undefined) continue
      const matId = conceptIndex.has(e.source) ? e.target : e.source
      if (!incidentConcept.has(matId)) incidentConcept.set(matId, ci)
    }
    materials.forEach((m, i) => {
      const idx = incidentConcept.get(m.id)
      const angle =
        idx !== undefined
          ? (idx / Math.max(1, conceptsRanked.length)) * Math.PI * 2 - Math.PI / 2
          : (i / Math.max(1, materials.length)) * Math.PI * 2
      // Spread leaves around their hub by a small per-material offset
      // so multiple materials on one concept don't collapse to a single
      // point on the outer ring.
      const offset = ((i * 0.27) % 1 - 0.5) * 0.5
      pos.set(m.id, {
        x: cx + Math.cos(angle + offset) * materialRadius,
        y: cy + Math.sin(angle + offset) * materialRadius,
        vx: 0,
        vy: 0,
      })
    })
  } else {
    placeRow(turns, 90)
    placeRow(materials, H - 90)
    placeRing(chunks, 130)
    placeRing(concepts, 180)
  }

  const adj: { a: string; b: string; rest: number }[] = graph.edges.map((e) => ({
    a: e.source,
    b: e.target,
    rest: mode === 'map' ? 150 : e.kind === 'next' ? 90 : 80,
  }))

  // Mode-tuned constants. Map needs more breathing room because labels
  // are longer and there are more nodes.
  const REPULSION = mode === 'map' ? 4200 : 1800
  const SPRING_K = mode === 'map' ? 0.035 : 0.05
  const CENTER_K = mode === 'map' ? 0.006 : 0.012
  const DAMPING = 0.84
  const ITER = mode === 'map' ? 320 : 240
  const MIN_DIST = 6

  // Cache label-aware bounding boxes so the anti-collision pass can
  // separate nodes by their actual rendered footprint (circle + label
  // pill below). Treating each node as an AABB instead of a circle is
  // what turns "labels piling on each other" into a clean layout —
  // bowing matters more horizontally than vertically because labels
  // stack downward.
  const bbox = new Map<
    string,
    { hw: number; topOffset: number; bottomOffset: number }
  >()
  for (const n of nodes) {
    const r = nodeRadius(n)
    if (n.type === 'material' || n.type === 'concept') {
      // Mirror the actual label rendering: width = chars * 6.0 + 12
      // (with a soft cap from `truncate(label, 26)`), drawn below the
      // circle from y = r+7 to y = r+26. Add an 8 px gutter (was 4)
      // so adjacent pills get visible breathing room — the "still
      // touching" feel is what makes a graph look cheap even after
      // the strict overlap is gone.
      const charCount = Math.min(26, (n.label ?? '').length)
      const labelW = charCount * 6.0 + 12
      bbox.set(n.id, {
        hw: Math.max(r, labelW / 2) + 8,
        topOffset: r + 6,
        bottomOffset: r + 32,
      })
    } else {
      bbox.set(n.id, { hw: r + 4, topOffset: r + 4, bottomOffset: r + 4 })
    }
  }

  for (let t = 0; t < ITER; t++) {
    const cooling = 1 - t / ITER
    const ids = [...pos.keys()]

    for (let i = 0; i < ids.length; i++) {
      const a = pos.get(ids[i])!
      for (let j = i + 1; j < ids.length; j++) {
        const b = pos.get(ids[j])!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < MIN_DIST * MIN_DIST) {
          dx = (i - j) * 0.5 + 0.1
          dy = (j - i) * 0.5 + 0.1
          d2 = dx * dx + dy * dy
        }
        const f = REPULSION / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx -= fx * cooling
        a.vy -= fy * cooling
        b.vx += fx * cooling
        b.vy += fy * cooling
      }
    }

    for (const e of adj) {
      const a = pos.get(e.a)
      const b = pos.get(e.b)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1
      const f = SPRING_K * (d - e.rest)
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx * cooling
      a.vy += fy * cooling
      b.vx -= fx * cooling
      b.vy -= fy * cooling
    }

    for (const p of pos.values()) {
      p.vx += (cx - p.x) * CENTER_K * cooling
      p.vy += (cy - p.y) * CENTER_K * cooling
      p.vx *= DAMPING
      p.vy *= DAMPING
      p.x += p.vx
      p.y += p.vy
      p.x = Math.max(40, Math.min(W - 40, p.x))
      p.y = Math.max(40, Math.min(H - 40, p.y))
    }
  }

  // Anti-collision pass — AABB-aware. The previous circular approach
  // under-counted label overlap because labels render as a wide rect
  // *below* the circle, not radially around it. We now compute the
  // actual rendered bounding box (circle + label pill) and push along
  // whichever axis has the smaller overlap — that's almost always the
  // vertical axis for two materials stacked above each other, which
  // produces a much tidier wiki-map layout than the old radial push.
  const ids = [...pos.keys()]
  const PASSES = mode === 'map' ? 22 : 6
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      const a = pos.get(ids[i])!
      const ba = bbox.get(ids[i])!
      for (let j = i + 1; j < ids.length; j++) {
        const b = pos.get(ids[j])!
        const bb = bbox.get(ids[j])!
        const dx = b.x - a.x
        const dy = b.y - a.y
        // Horizontal overlap: combined half-widths minus centre-distance.
        const overlapX = ba.hw + bb.hw - Math.abs(dx)
        if (overlapX <= 0) continue
        // Vertical overlap: each node's box reaches `-topOffset` above
        // its centre and `+bottomOffset` below. Boxes overlap on Y if
        // (a.y - ba.topOffset) < (b.y + bb.bottomOffset) AND vice versa.
        const aTop = -ba.topOffset
        const aBot = ba.bottomOffset
        const bTop = -bb.topOffset
        const bBot = bb.bottomOffset
        const overlapY =
          Math.min(aBot, dy + bBot) - Math.max(aTop, dy + bTop)
        if (overlapY <= 0) continue
        // Minimum-translation vector: push along the axis with the
        // smaller overlap so we displace as little as possible.
        // Per-pass push is bumped to +1 (was +0.5) so dense clusters
        // converge in fewer passes — the previous gentle 0.5 nudge
        // could leave nodes nominally non-overlapping but visually
        // "kissing" at the rim.
        if (overlapX < overlapY) {
          const push = overlapX / 2 + 1
          const sx = dx >= 0 ? 1 : -1
          a.x -= sx * push
          b.x += sx * push
        } else {
          const push = overlapY / 2 + 1
          const sy = dy >= 0 ? 1 : -1
          a.y -= sy * push
          b.y += sy * push
        }
        moved = true
      }
    }
    // Re-clamp after each pass so collisions near the edges don't push
    // nodes out of the viewport. The clamp lets the fit-to-content
    // viewBox still re-frame the cluster afterwards.
    for (const p of pos.values()) {
      p.x = Math.max(40, Math.min(W - 40, p.x))
      p.y = Math.max(40, Math.min(H - 40, p.y))
    }
    if (!moved) break
  }

  const out = new Map<string, { x: number; y: number }>()
  for (const [k, v] of pos) out.set(k, { x: v.x, y: v.y })
  return out
}
