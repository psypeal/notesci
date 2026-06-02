/**
 * In-context model picker for the chat composer (and reusable wherever
 * a single LLM choice is needed).
 *
 * Displays the active model as a tiny pill (provider · short label).
 * Clicking opens a popover grouped by provider; unavailable models are
 * greyed out (and unselectable).
 *
 * The popover renders in a portal with viewport-aware positioning so
 * it never gets clipped by a narrow chat pane or the parent's overflow.
 *
 * The pill is controlled — the host owns `value` (the canonical
 * model id, or null = "use server default") and `onChange`. We
 * fetch the catalog from `/providers/available` and re-render when
 * it refreshes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '../icons'
import {
  getProviders,
  modelShortLabel,
  peekProviders,
  subscribeProviders,
  type ModelInfo,
  type ProvidersAvailable,
} from '../../lib/models'

const POPOVER_W = 320
const POPOVER_MARGIN = 8 // breathing room from viewport edges
const POPOVER_GAP = 6 // gap between trigger and popover

export function ModelPill({
  value,
  onChange,
  size = 'tiny',
  align = 'right',
}: {
  /** Canonical "<provider>:<model_id>" or null to mean "server default". */
  value: string | null
  onChange: (next: string | null) => void
  size?: 'tiny' | 'small'
  /** Preferred horizontal anchor — viewport clamping may override. */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ProvidersAvailable | null>(() =>
    peekProviders(),
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Fetch + subscribe on mount.
  useEffect(() => {
    let alive = true
    void getProviders().then((p) => {
      if (alive) setCatalog(p)
    })
    const off = subscribeProviders(setCatalog)
    return () => {
      alive = false
      off()
    }
  }, [])

  // Close on outside-click / Esc.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        triggerRef.current?.contains(t) ||
        popoverRef.current?.contains(t)
      ) {
        return
      }
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const groups = useMemo(() => {
    if (!catalog) return []
    // Defensive: a stale-build disk cache may be missing either field —
    // `peekProviders()` returns it untouched. Treat missing arrays as
    // empty so we render an empty picker instead of crashing the pane.
    const providers = catalog.providers ?? []
    const models = catalog.models ?? []
    const out: { provider_id: string; display_name: string; models: ModelInfo[] }[] = []
    for (const p of providers) {
      const ms = models.filter((m) => m.provider_id === p.id)
      if (ms.length > 0) {
        out.push({ provider_id: p.id, display_name: p.display_name, models: ms })
      }
    }
    return out
  }, [catalog])

  // The model actually in effect for the next message — the user's
  // explicit pick if it's available, otherwise whatever the server
  // resolves to. We present *this* directly; there's no "default
  // model" concept surfaced to the user anymore.
  const effective = useMemo(() => {
    if (value && catalog) {
      // Same defensiveness as `groups` above — a stale/partial catalog
      // payload may be missing the `models` array. Treat it as no-match
      // so the picker still renders instead of crashing the pane.
      const m = (catalog.models ?? []).find((x) => x.id === value)
      if (m && m.available) return value
    }
    return catalog?.fallback_model ?? value ?? null
  }, [value, catalog])

  // The pill simply shows the current model — no "Pick a model" nag,
  // no "default" framing. Whatever the next message will run on, that's
  // what the user sees.
  const label =
    (effective ? modelShortLabel(effective, catalog) : null) ??
    effective ??
    'Model'

  const fontSize = size === 'tiny' ? 10.5 : 11.5

  // Hide the picker entirely when the user has nothing to pick from.
  // The agent will route to whichever model is available; bothering
  // them with a single-option dropdown is friction. Two thresholds:
  //   * 0 available  → nothing configured yet; we hide.
  //   * 1 available  → no choice to make; we hide.
  // The Settings → Models & keys page is where they enable more.
  const availableCount = (catalog?.models ?? []).filter((m) => m.available)
    .length
  if (availableCount <= 1) return null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tag"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${label}. Click to change.`}
        title={`Model: ${label}. Click to change.`}
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize,
          cursor: 'pointer',
          background: 'transparent',
          fontFamily: 'inherit',
          gap: 4,
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <Icons.bot size={11} />
        <span
          style={{
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <Icons.chevDown size={10} />
      </button>
      {open && (
        <PopoverPortal
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          align={align}
        >
          {!catalog && (
            <div
              style={{
                padding: '10px 12px',
                color: 'var(--color-muted)',
                fontSize: 12.5,
              }}
            >
              Loading models…
            </div>
          )}
          {catalog && (
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => {
                onChange(null)
                setOpen(false)
                triggerRef.current?.focus()
              }}
              style={rowStyle(value === null, true)}
            >
              {/* "Current" — selecting this clears the explicit pick
                  and lets the server resolve the model. Labelled
                  "Current" (not "Automatic") so it reads as a status
                  row: its caption shows the model actually in effect. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12.5 }}>Current</span>
                {value === null && <Icons.starFill size={9} />}
              </div>
              <span
                className="font-mono"
                style={{ fontSize: 10.5, color: 'var(--color-muted)' }}
              >
                {/* Always reflects the model actually in effect for the
                    next message — the user's explicit pick if set,
                    otherwise the server fallback. Gives a direct
                    "what am I running on?" answer regardless of which
                    row is selected. */}
                {effective
                  ? `using ${modelShortLabel(effective, catalog) ?? effective}`
                  : 'no providers configured'}
              </span>
            </button>
          )}
          {groups.map((g) => {
            return (
              <div key={g.provider_id} style={{ marginTop: 6 }}>
                <div
                  className="font-mono"
                  style={{
                    padding: '6px 8px 4px',
                    fontSize: 10,
                    letterSpacing: '0.1em',
                    color: 'var(--color-muted)',
                    textTransform: 'uppercase',
                  }}
                >
                  {g.display_name}
                </div>
                {g.models.map((m) => {
                  const selected = value === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={!m.available}
                      onClick={() => {
                        if (!m.available) return
                        onChange(m.id)
                        setOpen(false)
                        triggerRef.current?.focus()
                      }}
                      title={m.available ? m.description : undefined}
                      style={rowStyle(selected, m.available)}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          width: '100%',
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12.5,
                            color: m.available ? 'var(--color-ink)' : 'var(--color-muted)',
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {m.label}
                        </span>
                        {m.kind === 'reasoning' && (
                          <span
                            className="tag"
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              background: 'var(--color-paper-2)',
                            }}
                          >
                            R
                          </span>
                        )}
                        {selected && <Icons.starFill size={9} />}
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--color-muted)',
                          marginTop: 2,
                          display: 'block',
                          lineHeight: 1.3,
                        }}
                      >
                        {m.description}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </PopoverPortal>
      )}
    </>
  )
}

/**
 * Renders children in a body-level portal positioned relative to
 * `triggerRef`, with the right edge aligned to the trigger's
 * preferred edge (per `align`) and clamped to fit inside the viewport
 * with a small margin. Re-positions on resize and scroll.
 */
function PopoverPortal({
  triggerRef,
  popoverRef,
  align,
  children,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  popoverRef: React.RefObject<HTMLDivElement | null>
  align: 'left' | 'right'
  children: React.ReactNode
}) {
  const [coords, setCoords] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
  } | null>(null)

  // Recompute on every layout change; cheap because the popover only
  // mounts when open.
  const recompute = () => {
    const trig = triggerRef.current
    if (!trig) return
    const rect = trig.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Width — never wider than viewport minus margins.
    const width = Math.min(POPOVER_W, vw - 2 * POPOVER_MARGIN)

    // Horizontal: prefer right-aligning to the trigger's right edge,
    // unless the viewport is too narrow on the left for that to fit.
    let left: number
    if (align === 'right') {
      const wantedLeft = rect.right - width
      left = Math.max(POPOVER_MARGIN, Math.min(wantedLeft, vw - width - POPOVER_MARGIN))
    } else {
      const wantedLeft = rect.left
      left = Math.max(POPOVER_MARGIN, Math.min(wantedLeft, vw - width - POPOVER_MARGIN))
    }

    // Vertical: open above the trigger (the pill lives at the bottom
    // of the composer, so flipping below would be cramped). If the
    // popover would extend above the viewport, the maxHeight clamps it
    // and the scrollbar takes over.
    const spaceAbove = rect.top - POPOVER_MARGIN - POPOVER_GAP
    const spaceBelow = vh - rect.bottom - POPOVER_MARGIN - POPOVER_GAP
    const flipBelow = spaceAbove < 200 && spaceBelow > spaceAbove

    let top: number
    let maxHeight: number
    if (flipBelow) {
      top = rect.bottom + POPOVER_GAP
      maxHeight = Math.max(120, spaceBelow)
    } else {
      // Tentatively render at full height; clamp if needed.
      maxHeight = Math.min(380, Math.max(120, spaceAbove))
      // We need the actual popover height to position the top edge
      // correctly. Use the rendered ref's height; for the very first
      // paint, fall back to maxHeight (so it clamps + opens upward).
      const popH = popoverRef.current?.offsetHeight ?? maxHeight
      top = rect.top - POPOVER_GAP - popH
      if (top < POPOVER_MARGIN) top = POPOVER_MARGIN
    }

    setCoords({ left, top, width, maxHeight })
  }

  useLayoutEffect(() => {
    recompute()
    // Re-run after the popover's own layout settles so the height-based
    // top calculation uses the real rendered height.
    const id = requestAnimationFrame(recompute)
    const onResize = () => recompute()
    const onScroll = () => recompute()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Don't paint a flash at (0,0) before the first measurement.
  const ready = coords !== null

  return createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      aria-label="Pick a model"
      style={{
        position: 'fixed',
        left: coords?.left ?? 0,
        top: coords?.top ?? 0,
        width: coords?.width ?? POPOVER_W,
        maxHeight: coords?.maxHeight ?? 380,
        overflow: 'auto',
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 10,
        boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
        zIndex: 1000,
        padding: 6,
        visibility: ready ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

function rowStyle(selected: boolean, enabled: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 1,
    padding: '8px 10px',
    width: '100%',
    border: 'none',
    background: selected ? 'var(--color-paper-2)' : 'transparent',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.55,
    borderRadius: 6,
    fontFamily: 'inherit',
    textAlign: 'left',
  }
}
