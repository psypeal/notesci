/**
 * Two-pane container with a draggable splitter between them, optional
 * fold buttons on the splitter, and per-instance localStorage persistence.
 *
 * `direction` describes the splitter's orientation:
 *   - 'vertical'   → splitter is a vertical bar; panes sit left/right.
 *   - 'horizontal' → splitter is a horizontal bar; panes sit top/bottom.
 *
 * `collapsible` opts which side(s) can be folded ('first' | 'second' |
 * 'both' | undefined). When set, small chevron buttons sit on the
 * splitter midpoint — always visible so users can discover them
 * without first knowing where to hover. Each button collapses the
 * side it points toward; once collapsed, the button flips to point
 * away (so the next click expands that side again).
 *
 * Ratio (0..1) is persisted to `storageKey`; collapsed side is
 * persisted to `${storageKey}_collapsed`. Both survive reloads.
 *
 * Keyboard accessible: focus the splitter, arrow keys nudge ±2%
 * (±5% with shift); Home / End jump to clamps; double-click resets
 * to the default ratio.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const HANDLE_THICKNESS = 6   // hit-target thickness when not collapsed
const COLLAPSED_BAR_PX = 18  // splitter strip width when one side is folded

type CollapsedSide = 'first' | 'second' | null

/**
 * Module-level store for collapsed state, keyed by storage key.
 * Survives mode-switch within a session (e.g. Chat → Draft → Chat)
 * but resets on page reload — so users don't return to a folded
 * pane they don't remember setting. Ratio still persists via
 * localStorage; only the fold state is session-scoped.
 */
const _collapsedSession = new Map<string, CollapsedSide>()

/** Drop the session-scoped collapsed state for every splitter — invoked
 *  from `signOut()` so the next user on this browser doesn't inherit
 *  the previous user's folded panes. Ratio state lives in localStorage
 *  and is wiped by the per-user `notesci_*` sweep in `signOut`. */
export function clearResizableSplitState(): void {
  _collapsedSession.clear()
  window.dispatchEvent(new CustomEvent('notesci-split-reset', { detail: null }))
}

/** Imperatively un-collapse the split with this storage key. Dispatches a
 *  custom event so any currently-mounted `ResizableSplit` instance with
 *  the matching key re-syncs from the module map. Used when the user does
 *  something that implies "show me this pane" — e.g. clicking a session
 *  in the sidebar should always reveal the chat pane, even if the user
 *  previously collapsed it in chat mode and then collapsed the reader in
 *  reader mode (which leaves both layouts' first-side state collapsed and
 *  produces a "click does nothing" experience). */
export function expandSplit(storageKey: string): void {
  _collapsedSession.delete(storageKey)
  window.dispatchEvent(
    new CustomEvent('notesci-split-reset', { detail: storageKey }),
  )
}

export function ResizableSplit({
  direction,
  storageKey,
  defaultRatio = 0.5,
  min = 0.25,
  max = 0.75,
  first,
  second,
  ariaLabel,
  collapsible,
  firstLabel = 'first pane',
  secondLabel = 'second pane',
}: {
  direction: 'vertical' | 'horizontal'
  storageKey: string
  defaultRatio?: number
  min?: number
  max?: number
  first: ReactNode
  second: ReactNode
  ariaLabel?: string
  /** Which sides the user is allowed to fold. Omit to disable folding. */
  collapsible?: 'first' | 'second' | 'both'
  /** Used in aria-labels for the fold buttons. */
  firstLabel?: string
  secondLabel?: string
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const [ratio, setRatio] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw != null) {
        const v = Number.parseFloat(raw)
        if (Number.isFinite(v) && v >= min && v <= max) return v
      }
    } catch {
      /* ignore */
    }
    return clamp(defaultRatio, min, max)
  })

  const [collapsed, setCollapsed] = useState<CollapsedSide>(() => {
    if (!collapsible) return null
    const cur = _collapsedSession.get(storageKey) ?? null
    if (cur === 'first' && (collapsible === 'first' || collapsible === 'both')) return 'first'
    if (cur === 'second' && (collapsible === 'second' || collapsible === 'both')) return 'second'
    return null
  })

  const persistRatio = useCallback(
    (next: number) => {
      try {
        localStorage.setItem(storageKey, String(next))
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  )

  const persistCollapsed = useCallback(
    (next: CollapsedSide) => {
      if (next === null) _collapsedSession.delete(storageKey)
      else _collapsedSession.set(storageKey, next)
    },
    [storageKey],
  )

  const toggleCollapsed = useCallback(
    (side: 'first' | 'second') => {
      const next: CollapsedSide = collapsed === side ? null : side
      setCollapsed(next)
      persistCollapsed(next)
    },
    [collapsed, persistCollapsed],
  )

  // External reset hook (see `expandSplit` above). The Workspace fires
  // `notesci-split-reset` with the storage key when an action should
  // imply "uncollapse that split" — e.g. clicking a session in the
  // sidebar should always reveal the chat. Without this, the module-
  // level `_collapsedSession` map keeps the prior collapsed state and
  // the user sees no visible change after their click.
  useEffect(() => {
    const onReset = (e: Event) => {
      const ev = e as CustomEvent<string | null>
      // `detail === null` from `clearResizableSplitState` resets every
      // split; otherwise only the matching storageKey resets.
      if (ev.detail != null && ev.detail !== storageKey) return
      setCollapsed(null)
    }
    window.addEventListener('notesci-split-reset', onReset)
    return () => window.removeEventListener('notesci-split-reset', onReset)
  }, [storageKey])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't start a drag while a side is collapsed — drag would be
      // meaningless since one pane has zero size. Click a chevron to
      // unfold first.
      if (collapsed) return
      e.preventDefault()
      draggingRef.current = true
      document.body.style.cursor =
        direction === 'vertical' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return
        const wrap = wrapRef.current
        if (!wrap) return
        const rect = wrap.getBoundingClientRect()
        let next: number
        if (direction === 'vertical') {
          next = (ev.clientX - rect.left) / rect.width
        } else {
          next = (ev.clientY - rect.top) / rect.height
        }
        next = clamp(next, min, max)
        setRatio(next)
      }
      const onUp = () => {
        if (!draggingRef.current) return
        draggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        setRatio((r) => {
          persistRatio(r)
          return r
        })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [direction, min, max, persistRatio, collapsed],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (collapsed) return
      const step = e.shiftKey ? 0.05 : 0.02
      let next = ratio
      if (direction === 'vertical') {
        if (e.key === 'ArrowLeft') next = ratio - step
        else if (e.key === 'ArrowRight') next = ratio + step
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        else return
      } else {
        if (e.key === 'ArrowUp') next = ratio - step
        else if (e.key === 'ArrowDown') next = ratio + step
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        else return
      }
      e.preventDefault()
      next = clamp(next, min, max)
      setRatio(next)
      persistRatio(next)
    },
    [ratio, direction, min, max, persistRatio, collapsed],
  )

  const onDoubleClick = useCallback(() => {
    if (collapsed) return
    const v = clamp(defaultRatio, min, max)
    setRatio(v)
    persistRatio(v)
  }, [defaultRatio, min, max, persistRatio, collapsed])

  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [])

  const isVertical = direction === 'vertical'

  // Effective flex per side: when one is collapsed, the other takes
  // everything. The collapsed pane gets display:none so it stops
  // capturing pointer events / occupying space.
  const firstHidden = collapsed === 'first'
  const secondHidden = collapsed === 'second'
  const firstFlex = firstHidden ? '0 0 0' : secondHidden ? '1 1 0' : `${ratio} 1 0`
  const secondFlex = secondHidden ? '0 0 0' : firstHidden ? '1 1 0' : `${1 - ratio} 1 0`

  const showFirstFold = collapsible === 'first' || collapsible === 'both'
  const showSecondFold = collapsible === 'second' || collapsible === 'both'

  // When collapsed, widen the splitter so the unfold chevron is easy
  // to find. Otherwise the splitter is a thin 6 px hit-target.
  const splitterThickness = collapsed ? COLLAPSED_BAR_PX : HANDLE_THICKNESS

  return (
    <div
      ref={wrapRef}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: isVertical ? 'row' : 'column',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: firstFlex,
          minWidth: 0,
          minHeight: 0,
          display: firstHidden ? 'none' : 'flex',
          flexDirection: 'column',
        }}
      >
        {first}
      </div>
      <div
        role="separator"
        tabIndex={collapsed ? -1 : 0}
        aria-orientation={isVertical ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-label={ariaLabel ?? 'Resize panes'}
        onMouseDown={collapsed ? undefined : onMouseDown}
        onKeyDown={collapsed ? undefined : onKeyDown}
        onDoubleClick={collapsed ? undefined : onDoubleClick}
        className="ns-splitter"
        data-direction={direction}
        data-collapsed={collapsed ?? undefined}
        style={{
          flexShrink: 0,
          cursor: collapsed ? 'default' : isVertical ? 'col-resize' : 'row-resize',
          width: isVertical ? splitterThickness : undefined,
          height: isVertical ? undefined : splitterThickness,
          // Negative margin pulls the wider hit-target inside the visible
          // 1 px rule so the bar visually stays at 1 px when not collapsed.
          margin: collapsed
            ? undefined
            : isVertical
              ? '0 -2.5px'
              : '-2.5px 0',
          position: 'relative',
          zIndex: 5,
          overflow: 'visible',
        }}
      >
        {(showFirstFold || showSecondFold) && (
          <FoldGroup
            direction={direction}
            collapsed={collapsed}
            showFirstFold={showFirstFold}
            showSecondFold={showSecondFold}
            firstLabel={firstLabel}
            secondLabel={secondLabel}
            onToggle={toggleCollapsed}
          />
        )}
      </div>
      <div
        style={{
          flex: secondFlex,
          minWidth: 0,
          minHeight: 0,
          display: secondHidden ? 'none' : 'flex',
          flexDirection: 'column',
        }}
      >
        {second}
      </div>
    </div>
  )
}

/**
 * Floating chevron button group, absolutely positioned on the splitter
 * so it doesn't depend on the splitter's narrow width to lay itself
 * out. Two chevrons sit adjacent in the splitter midpoint.
 *
 * For a vertical splitter (panes left|right):
 *   - "first" chevron points LEFT when active (collapses the left
 *     pane); flips to RIGHT once collapsed (click expands).
 *   - "second" chevron points RIGHT when active (collapses right
 *     pane); flips to LEFT once collapsed.
 *
 * For a horizontal splitter (panes top|bottom): same logic with
 * UP/DOWN.
 */
function FoldGroup({
  direction,
  collapsed,
  showFirstFold,
  showSecondFold,
  firstLabel,
  secondLabel,
  onToggle,
}: {
  direction: 'vertical' | 'horizontal'
  collapsed: CollapsedSide
  showFirstFold: boolean
  showSecondFold: boolean
  firstLabel: string
  secondLabel: string
  onToggle: (side: 'first' | 'second') => void
}) {
  const isVertical = direction === 'vertical'

  // When one side is folded, only show the chevron that expands that
  // side (the other one would be a no-op).
  const renderFirst = showFirstFold && (collapsed === null || collapsed === 'first')
  const renderSecond = showSecondFold && (collapsed === null || collapsed === 'second')

  return (
    <div
      style={{
        position: 'absolute',
        // Center on the splitter's cross-axis and main-axis midpoint.
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        gap: 4,
        // The buttons are visually larger than the splitter — make sure
        // they sit ABOVE the panes (which have white backgrounds) so
        // they're never hidden.
        zIndex: 6,
        pointerEvents: 'none', // each button re-enables it
      }}
    >
      {renderFirst && (
        <FoldButton
          direction={direction}
          targetSide="first"
          collapsed={collapsed === 'first'}
          targetLabel={firstLabel}
          onClick={() => onToggle('first')}
        />
      )}
      {renderSecond && (
        <FoldButton
          direction={direction}
          targetSide="second"
          collapsed={collapsed === 'second'}
          targetLabel={secondLabel}
          onClick={() => onToggle('second')}
        />
      )}
    </div>
  )
}

function FoldButton({
  direction,
  targetSide,
  collapsed,
  targetLabel,
  onClick,
}: {
  direction: 'vertical' | 'horizontal'
  targetSide: 'first' | 'second'
  collapsed: boolean
  targetLabel: string
  onClick: () => void
}) {
  const isVertical = direction === 'vertical'
  // Chevron glyph: when not collapsed, point TOWARD the side that
  // will be hidden. When collapsed, point AWAY from that side (= the
  // direction the pane will re-emerge from when expanded).
  let glyph: string
  if (isVertical) {
    if (targetSide === 'first') glyph = collapsed ? '›' : '‹'
    else glyph = collapsed ? '‹' : '›'
  } else {
    if (targetSide === 'first') glyph = collapsed ? '⌄' : '⌃'
    else glyph = collapsed ? '⌃' : '⌄'
  }
  const label = collapsed ? `Show ${targetLabel}` : `Hide ${targetLabel}`
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="ns-splitter-fold"
      aria-label={label}
      title={label}
      style={{
        width: 18,
        height: 18,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--color-rule)',
        borderRadius: 4,
        background: '#fff',
        color: 'var(--color-muted)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1,
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        pointerEvents: 'auto',
      }}
    >
      <span aria-hidden>{glyph}</span>
    </button>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}
