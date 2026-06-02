import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Icons } from '../icons'
import { relativeTime } from '../../lib/relative-time'

export interface PaletteItem {
  /** Unique identifier — used for the React key. */
  id: string
  kind: 'session' | 'material' | 'page' | 'action'
  label: string
  hint?: string
  /** Callback when the user picks this row. The caller usually closes the palette. */
  onSelect: () => void
}

/**
 * ⌘K command palette. Opens on ⌘K / Ctrl+K, closes on Esc, navigates
 * with ↑/↓, selects with Enter. Items are filtered by case-insensitive
 * substring on `label` + `hint`.
 *
 * The host (Workspace) supplies items: the open sessions, the project's
 * materials, jump-to-page entries, and a few standing actions
 * ("New session", "Sign out", etc.).
 */
export function CommandPalette({
  items,
  open,
  onClose,
}: {
  items: PaletteItem[]
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listboxId = useId()
  const rowIdPrefix = useId()

  // Reset query/cursor every time the palette opens. Save the
  // previously-focused element so we can restore focus on close.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    const previouslyFocused = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      // Only restore if the previously-focused element is still around
      // (e.g. the host TopBar search button).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus?.()
      }
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 50)
    return items
      .filter((it) =>
        (it.label + ' ' + (it.hint ?? '')).toLowerCase().includes(q),
      )
      .slice(0, 50)
  }, [items, query])

  // Reset the cursor to the top of the filtered list whenever the
  // query changes — most-relevant matches sort first, so jumping the
  // selection there matches user intent. Also clamps when the list
  // shrinks (e.g. `cursor` was past the new length).
  useEffect(() => {
    setCursor(0)
  }, [query])
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1))
  }, [cursor, filtered.length])

  // Keep the active row visible as the user arrows past the viewport.
  useEffect(() => {
    if (!open) return
    const id = `${rowIdPrefix}-${cursor}`
    const el = document.getElementById(id)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open, rowIdPrefix])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME guard — while an input-method composition is active, let the
    // IME own every key (Enter confirms a candidate, arrows navigate
    // candidates). Without this, a CJK search query can't be typed.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(filtered.length - 1, c + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    // Home/End jump to first/last filtered item — standard listbox
    // behavior and makes long result lists navigable without holding
    // ArrowUp/ArrowDown.
    if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setCursor(Math.max(0, filtered.length - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[cursor]
      if (item) {
        item.onSelect()
        onClose()
      }
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14,17,22,0.42)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: 'calc(100vw - 32px)',
          background: 'var(--color-paper)',
          borderRadius: 14,
          border: '1px solid var(--color-rule)',
          boxShadow: '0 24px 64px -16px rgba(14,17,22,0.32)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: '1px solid var(--color-rule)',
          }}
        >
          <Icons.search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a session, material, or run a command…"
            aria-label="Command palette search"
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={
              filtered[cursor] ? `${rowIdPrefix}-${cursor}` : undefined
            }
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 14,
              color: 'var(--color-ink)',
              fontFamily: 'inherit',
            }}
          />
          <span
            className="font-mono"
            style={{ fontSize: 11, color: 'var(--color-muted)' }}
          >
            esc
          </span>
        </div>
        <div
          role="listbox"
          id={listboxId}
          aria-label="Command palette results"
          style={{ maxHeight: '50vh', overflow: 'auto', padding: '6px 0' }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '24px 18px',
                color: 'var(--color-muted)',
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              No matches for "{query}".
            </div>
          ) : (
            filtered.map((it, i) => (
              <Row
                key={it.id}
                rowId={`${rowIdPrefix}-${i}`}
                item={it}
                active={i === cursor}
                onHover={() => setCursor(i)}
                onClick={() => {
                  it.onSelect()
                  onClose()
                }}
              />
            ))
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 14,
            padding: '8px 16px',
            borderTop: '1px solid var(--color-rule)',
            fontSize: 11,
            color: 'var(--color-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

function Row({
  item,
  rowId,
  active,
  onHover,
  onClick,
}: {
  item: PaletteItem
  rowId: string
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  const Icon =
    item.kind === 'session'
      ? Icons.bot
      : item.kind === 'material'
        ? Icons.doc
        : item.kind === 'page'
          ? Icons.layers
          : Icons.sparkles
  return (
    <div
      id={rowId}
      onMouseEnter={onHover}
      onClick={onClick}
      role="option"
      aria-selected={active}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        background: active ? 'var(--color-paper-2)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <Icon size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--color-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.label}
        </div>
        {item.hint && (
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              color: 'var(--color-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.hint}
          </div>
        )}
      </div>
      <span
        className="tag"
        style={{ fontSize: 10, color: 'var(--color-muted)' }}
      >
        {item.kind.toUpperCase()}
      </span>
    </div>
  )
}

/**
 * Keyboard listener. Returns the open state + setter; host renders the
 * palette and provides items.
 */
export function useCommandPalette(): readonly [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘/Ctrl + K only — leave ⌘⇧K and ⌘⌥K to the browser/OS.
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((cur) => !cur)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  return [open, setOpen] as const
}

/** Convenience: builds a default item set for use in Workspace. */
export function buildDefaultItems(opts: {
  sessions: { id: string; title: string | null; updated_at: string }[]
  materials: { id: string; title: string | null; source_type: string }[]
  navigate: ReturnType<typeof useNavigate>
  onPickSession: (id: string) => void
  onPickMaterial?: (id: string) => void
  onNewSession: () => void
  onLayout: (m: 'chat' | 'reader' | 'draft') => void
}): PaletteItem[] {
  const items: PaletteItem[] = []

  // Sessions
  for (const s of opts.sessions) {
    items.push({
      id: `session:${s.id}`,
      kind: 'session',
      label: s.title ?? 'Untitled session',
      hint: `${s.id.slice(0, 8)} · updated ${relativeTime(s.updated_at)}`,
      onSelect: () => opts.onPickSession(s.id),
    })
  }

  // Materials
  for (const m of opts.materials) {
    items.push({
      id: `material:${m.id}`,
      kind: 'material',
      label: m.title ?? 'Untitled material',
      hint: m.source_type.toUpperCase(),
      onSelect: () => {
        if (opts.onPickMaterial) {
          opts.onPickMaterial(m.id)
        } else {
          opts.onLayout('reader')
        }
      },
    })
  }

  // Standing actions
  items.push({
    id: 'action:new-session',
    kind: 'action',
    label: 'New session',
    hint: 'Start a fresh chat',
    onSelect: opts.onNewSession,
  })
  items.push({
    id: 'action:layout-chat',
    kind: 'action',
    label: 'Switch to Chat layout',
    hint: 'Chat over graph',
    onSelect: () => opts.onLayout('chat'),
  })
  items.push({
    id: 'action:layout-reader',
    kind: 'action',
    label: 'Switch to Reader layout',
    hint: 'Reader + graph',
    onSelect: () => opts.onLayout('reader'),
  })
  items.push({
    id: 'action:layout-draft',
    kind: 'action',
    label: 'Switch to Draft layout',
    hint: 'Drafts library',
    onSelect: () => opts.onLayout('draft'),
  })

  // Jump-to pages
  const pages: [string, string][] = [
    ['/library', 'Library — all projects'],
    ['/settings/preferences', 'Preferences'],
    ['/settings/marketplace', 'Marketplace'],
    ['/settings/mcp/installed', 'MCP servers'],
    ['/settings/models', 'Models & keys'],
    ['/settings/citations', 'Citations & export'],
    ['/settings/sources', 'Sources'],
  ]
  for (const [path, label] of pages) {
    items.push({
      id: `page:${path}`,
      kind: 'page',
      label,
      hint: path,
      onSelect: () => opts.navigate(path),
    })
  }

  return items
}
