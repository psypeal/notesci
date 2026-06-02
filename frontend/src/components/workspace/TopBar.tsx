import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Mark } from '../brand/Mark'
import { Icons } from '../icons'
export type LayoutMode = 'chat' | 'reader' | 'draft'

export interface ProjectSummary {
  id: string
  name: string
  updated_at: string
}

const LAYOUTS: [LayoutMode, string][] = [
  ['chat', 'Chat'],
  ['reader', 'Reader'],
  ['draft', 'Draft'],
]

/**
 * Workspace top bar — chrome above the 3-pane area.
 *
 * Mark · project switcher · layout-mode pill · search/command
 * placeholder · Share / New session · invite pill · avatar.
 *
 * Mirrors the design handoff's `TopBar` from `ws-panes.jsx`.
 */
export function TopBar({
  projectName,
  activeProjectId,
  projects,
  onPickProject,
  onNewProject,
  onRenameProject,
  onDeleteProject,
  layout,
  onLayout,
  onClickNewSession,
  onClickSearch,
  initials = '·',
}: {
  projectName: string
  activeProjectId: string | null
  projects: ProjectSummary[]
  onPickProject: (id: string) => void
  onNewProject: () => Promise<void> | void
  /** Rename a project. The switcher row collects the new name inline;
   *  the parent owns the optimistic update + PATCH. */
  onRenameProject?: (id: string, nextName: string) => void
  /** Delete a project. The parent owns the confirm prompt + toast. */
  onDeleteProject?: (id: string) => void
  layout: LayoutMode
  onLayout: (mode: LayoutMode) => void
  onClickNewSession?: () => void
  onClickSearch?: () => void
  initials?: string
}) {
  const [open, setOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement | null>(null)
  const projTriggerRef = useRef<HTMLButtonElement | null>(null)
  const projMenuId = useId()
  const [acctOpen, setAcctOpen] = useState(false)
  const acctRef = useRef<HTMLDivElement | null>(null)
  const acctTriggerRef = useRef<HTMLButtonElement | null>(null)
  const acctMenuId = useId()
  const navigate = useNavigate()
  // Close account menu on outside click or Escape.
  useEffect(() => {
    if (!acctOpen) return
    const onDoc = (e: MouseEvent) => {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) {
        setAcctOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAcctOpen(false)
        // Return focus to the trigger so keyboard users don't lose
        // their place when the menu dismisses.
        acctTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [acctOpen])
  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        projTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <header
      className="ns-glass-chrome"
      style={{
        height: 48,
        borderBottom: '1px solid var(--color-glass-border-soft)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: 14,
        fontSize: 13,
        color: 'var(--color-ink)',
        flexShrink: 0,
        // Sticky for stacking parity with General page's header (also
        // sticky/top:0/zIndex:10) — both surfaces now anchor their
        // chrome the same way during scroll.
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      <Link
        to="/"
        aria-label="Back to general chat"
        title="Back to general chat"
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          textDecoration: 'none',
          borderRadius: 6,
          padding: 2,
        }}
      >
        <Mark size={26} />
      </Link>
      {/* Sidebar toggle moved into SidePanel so it sits next to the
          panel it controls — same placement General uses. When the
          panel is collapsed the toggle floats as a rail (see
          SidePanel + Workspace.tsx). */}
      <div
        aria-hidden
        style={{
          width: 1,
          height: 18,
          background: 'var(--color-rule)',
          marginLeft: 4,
          flexShrink: 0,
        }}
      />
      <div ref={dropRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          ref={projTriggerRef}
          type="button"
          className="row ws-topbar-project"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={projMenuId}
          aria-label={`Switch project · current: ${projectName}`}
          style={{
            padding: '5px 10px',
            borderRadius: 6,
            fontSize: 13,
            background: 'transparent',
            border: 'none',
            fontFamily: 'inherit',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span
            className="ws-topbar-project-name"
            style={{
              fontWeight: 500,
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {projectName}
          </span>
          <Icons.chevDown size={14} />
        </button>
        {open && (
          <div
            id={projMenuId}
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              minWidth: 280,
              maxHeight: 'min(70vh, 480px)',
              overflowY: 'auto',
              background: '#fff',
              border: '1px solid var(--color-rule)',
              borderRadius: 10,
              boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
              zIndex: 30,
              padding: 6,
            }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 10.5,
                letterSpacing: '0.08em',
                color: 'var(--color-muted)',
                padding: '6px 10px 4px',
                textTransform: 'uppercase',
              }}
            >
              Projects · {projects.length}
            </div>
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                active={p.id === activeProjectId}
                onPick={() => {
                  onPickProject(p.id)
                  setOpen(false)
                }}
                onRename={onRenameProject}
                onDelete={
                  onDeleteProject
                    ? () => {
                        setOpen(false)
                        onDeleteProject(p.id)
                      }
                    : undefined
                }
              />
            ))}
            <div
              role="separator"
              style={{
                height: 1,
                background: 'var(--color-rule)',
                margin: '6px 0',
              }}
            />
            <button
              type="button"
              role="menuitem"
              className="ns-menu-item"
              onClick={async () => {
                setOpen(false)
                await onNewProject()
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                width: '100%',
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
                borderRadius: 6,
                color: 'var(--color-indigo)',
              }}
            >
              <Icons.plus size={12} /> New project…
            </button>
          </div>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Workspace layout"
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 30,
          boxSizing: 'border-box',
          padding: 3,
          background: 'var(--color-paper-2)',
          borderRadius: 8,
          border: '1px solid var(--color-rule)',
          marginLeft: 4,
          flexShrink: 0,
        }}
      >
        {LAYOUTS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            onClick={() => onLayout(id)}
            aria-selected={layout === id}
            aria-label={label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 22,
              padding: '0 10px',
              fontSize: 11.5,
              borderRadius: 6,
              border: 'none',
              background: layout === id ? 'var(--color-ink)' : 'transparent',
              color: layout === id ? 'var(--color-paper)' : 'var(--color-ink-2)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          minWidth: 0,
        }}
      >
        <button
          type="button"
          onClick={onClickSearch}
          className="ws-topbar-search"
          style={{
            width: '100%',
            maxWidth: 520,
            minWidth: 0,
            height: 30,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 10px',
            border: '1px solid var(--color-rule)',
            borderRadius: 8,
            background: 'var(--color-paper-2)',
            color: 'var(--color-muted)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 12.5,
            textAlign: 'left',
          }}
          aria-label="Open command palette"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Icons.search size={14} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Search materials, sessions, or run a command…
          </span>
          <kbd
            className="font-mono ws-topbar-kbd"
            style={{ fontSize: 11, flexShrink: 0 }}
          >
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Share removed — notesci is a single-user local app; there's no
          one to share a link with. (onClickShare/shareCopied props kept
          optional for callers but no longer rendered.) */}
      <button
        type="button"
        className="ns-btn tiny ws-topbar-new"
        style={{ height: 30, padding: '0 10px', gap: 6, flexShrink: 0 }}
        onClick={onClickNewSession}
        aria-label="New session"
        title="New session"
      >
        <Icons.sparkles size={12} />
        <span className="ws-topbar-btn-label">New session</span>
      </button>
      <div ref={acctRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          ref={acctTriggerRef}
          type="button"
          onClick={() => setAcctOpen((o) => !o)}
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={acctOpen}
          aria-controls={acctMenuId}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            background: 'var(--color-indigo)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          {initials}
        </button>
        {acctOpen && (
          <div
            id={acctMenuId}
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              minWidth: 200,
              background: '#fff',
              border: '1px solid var(--color-rule)',
              borderRadius: 10,
              boxShadow: '0 16px 32px rgba(0,0,0,0.14)',
              zIndex: 30,
              padding: 6,
              fontSize: 13,
              color: 'var(--color-ink)',
            }}
          >
            <AcctItem
              icon={<Icons.layers size={12} />}
              label="Preferences"
              onClick={() => {
                setAcctOpen(false)
                navigate('/settings/preferences')
              }}
            />
            <AcctItem
              icon={<Icons.doc size={12} />}
              label="Library"
              onClick={() => {
                setAcctOpen(false)
                navigate('/library')
              }}
            />
          </div>
        )}
      </div>
    </header>
  )
}

function AcctItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="ns-menu-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        width: '100%',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        borderRadius: 6,
        color: destructive ? 'var(--color-error)' : 'inherit',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

const PROJECT_MENU_ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 9px',
  width: '100%',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12.5,
  borderRadius: 6,
  color: 'inherit',
}

/**
 * One row in the project switcher dropdown. Click the name to switch
 * projects; hover/focus reveals a kebab → Rename (inline input) /
 * Delete. Mirrors SidePanel's `SessionRow`.
 */
function ProjectRow({
  project,
  active,
  onPick,
  onRename,
  onDelete,
}: {
  project: ProjectSummary
  active: boolean
  onPick: () => void
  onRename?: (id: string, nextName: string) => void
  onDelete?: () => void
}) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  // Close the kebab menu on outside-click / Esc.
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (
        menuWrapRef.current &&
        !menuWrapRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        menuTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Focus + select the rename field as soon as it mounts.
  useEffect(() => {
    if (renaming) {
      const el = renameInputRef.current
      el?.focus()
      el?.select()
    }
  }, [renaming])

  const commitRename = () => {
    const next = draft.trim()
    setRenaming(false)
    // Only fire when the name actually changed and isn't empty — an
    // empty rename is a no-op (the backend would 400 anyway).
    if (next && next !== project.name.trim() && onRename) {
      onRename(project.id, next)
    }
  }

  const showKebab = !renaming && (hover || active || menuOpen)
  const hasMenu = !!onRename || !!onDelete

  return (
    <div
      className={`row ${active ? 'active' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 6,
        background: active ? 'var(--color-paper-2)' : 'transparent',
        position: 'relative',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {renaming ? (
        <input
          ref={renameInputRef}
          className="ns-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // IME guard — Enter while composing confirms an input-method
            // candidate (e.g. a Chinese character); it must not commit
            // the rename.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') {
              e.preventDefault()
              commitRename()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(project.name)
              setRenaming(false)
            }
          }}
          onBlur={commitRename}
          placeholder="Project name…"
          aria-label={`Rename project "${project.name}"`}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            padding: '3px 8px',
            height: 28,
          }}
        />
      ) : (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={onPick}
            onFocus={() => setHover(true)}
            onBlur={() => setHover(false)}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'block',
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
              padding: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.name}
          </button>
          {active && (
            <span
              aria-hidden
              style={{
                color: 'var(--color-teal)',
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              ✓
            </span>
          )}
          {hasMenu && (
            <div
              ref={menuWrapRef}
              style={{ position: 'relative', flexShrink: 0 }}
            >
              <button
                ref={menuTriggerRef}
                type="button"
                aria-label={`Project options for "${project.name}"`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Rename or delete"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((o) => !o)
                }}
                style={{
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: 'none',
                  borderRadius: 5,
                  background: menuOpen
                    ? 'rgba(14,17,22,0.06)'
                    : 'transparent',
                  color: 'var(--color-muted)',
                  cursor: 'pointer',
                  display: showKebab ? 'inline-flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icons.kebab size={14} />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    right: 0,
                    minWidth: 150,
                    background: '#fff',
                    border: '1px solid var(--color-rule)',
                    borderRadius: 9,
                    boxShadow: '0 12px 28px -8px rgba(14,17,22,0.22)',
                    padding: 5,
                    zIndex: 40,
                  }}
                >
                  {onRename && (
                    <button
                      type="button"
                      role="menuitem"
                      className="ns-menu-item"
                      onClick={() => {
                        setMenuOpen(false)
                        setDraft(project.name)
                        setRenaming(true)
                      }}
                      style={PROJECT_MENU_ITEM_STYLE}
                    >
                      <Icons.doc size={12} /> Rename
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      role="menuitem"
                      className="ns-menu-item"
                      onClick={() => {
                        setMenuOpen(false)
                        onDelete()
                      }}
                      style={{
                        ...PROJECT_MENU_ITEM_STYLE,
                        color: 'var(--color-error)',
                      }}
                    >
                      <Icons.trash size={12} /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function SidebarGlyph({ open }: { open: boolean }) {
  // Small panel icon — a 16×14 rectangle with a vertical divider near the
  // left edge that solidifies into a fill when the sidebar is open.
  return (
    <svg
      width={16}
      height={14}
      viewBox="0 0 16 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x={1} y={1} width={14} height={12} rx={2} />
      <line x1={6} y1={1} x2={6} y2={13} />
      {open && <rect x={1} y={1} width={5} height={12} rx={2} fill="currentColor" opacity={0.18} />}
    </svg>
  )
}
