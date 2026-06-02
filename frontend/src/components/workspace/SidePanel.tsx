import { useEffect, useRef, useState } from 'react'
import { Icons } from '../icons'
import { SearchBar } from '../SearchBar'
import { useToast } from '../Toast'
import { SidebarGlyph } from './TopBar'
import { relativeTime } from '../../lib/relative-time'
import type { IngestionJob } from './IngestionTracker'

export interface SessionItem {
  id: string
  title: string | null
  updated_at: string
  active?: boolean
}

export interface MaterialItem {
  id: string
  title: string | null
  source_type: string
  created_at: string
  uri?: string | null
}

type MaterialFilter = 'all' | 'pdf' | 'note' | 'doc'

const SESSIONS_GROUP_KEY = 'notesci_sidegroup_sessions'
const MATERIALS_GROUP_KEY = 'notesci_sidegroup_materials'

const FILTERS: { id: MaterialFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pdf', label: 'PDF' },
  { id: 'note', label: 'Notes' },
  { id: 'doc', label: 'URLs' },
]

/**
 * Left pane: project header + tags + per-project search + sessions
 * group + materials group. Mirrors `SidePanel` in `ws-panes.jsx`.
 *
 * The search box filters both groups by case-insensitive substring on
 * title; the filter chips scope materials by `source_type`. Both are
 * client-side over the already-loaded lists — fine for project-sized
 * collections; switch to a server-side fanout if a project routinely
 * has hundreds of sessions or sources.
 */
export function SidePanel({
  projectName,
  projectTags = [],
  sessions,
  materials,
  activeSessionId,
  activeMaterialId,
  onSelectSession,
  onSelectMaterial,
  onRenameMaterial,
  onDeleteMaterial,
  onRenameSession,
  onDeleteSession,
  onNewSession,
  onNewProject,
  onAddSource,
  ingestingIds,
  ingestionJobs,
  width = 280,
  onCollapse,
}: {
  projectName: string
  projectTags?: string[]
  sessions: SessionItem[]
  materials: MaterialItem[]
  activeSessionId: string | null
  activeMaterialId?: string | null
  onSelectSession: (id: string) => void
  onSelectMaterial?: (id: string) => void
  /** Rename a material. The row collects the new title inline; the
   *  parent owns the API call, optimistic list update, and the
   *  cross-pane refresh (graph lenses, citation chips) so renamed
   *  titles propagate everywhere. */
  onRenameMaterial?: (id: string, nextTitle: string) => void
  /** Permanently delete a material. The parent owns the confirm
   *  prompt + toast, so the row just relays the click. Title is
   *  passed through to the parent so its confirm message can include it. */
  onDeleteMaterial?: (id: string, title: string | null) => void
  /** Rename a session. The row collects the new title inline; the
   *  parent owns the API call + optimistic list update. */
  onRenameSession?: (id: string, nextTitle: string) => void
  /** Delete a session. The parent owns the confirm prompt + toast. */
  onDeleteSession?: (id: string, title: string | null) => void
  onNewSession: () => void
  /** Open the new-project dialog. The PROJECT-header "+" button in
   *  the sidebar is wired to this — adding a SOURCE has its own "+"
   *  in the Materials section so the two actions don't share a
   *  control. (Previously the project-header "+" opened the upload
   *  picker, which was confusing — see `onAddSource`.) */
  onNewProject?: () => void
  /** Open the project's file picker (PDF upload). When supplied, the
   *  Materials "+" button opens it directly instead of routing the
   *  user through the chat composer. */
  onAddSource?: () => void
  /** Material IDs currently going through the ingestion pipeline.
   *  Their rows animate a spinner + "ingesting" badge so the user sees
   *  rename / link work is still happening. */
  ingestingIds?: ReadonlySet<string>
  /** Per-material ingestion job info. When present for a row, the
   *  MaterialRow renders an inline progress bar + stage label instead
   *  of the dot, so the user can see exactly which pipeline stage is
   *  running and how far along it is. */
  ingestionJobs?: ReadonlyMap<string, IngestionJob>
  width?: number
  /** Hide-sidebar callback. When provided, the panel header renders a
   *  small toggle (same SidebarGlyph icon used in the chat surface). */
  onCollapse?: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<MaterialFilter>('all')
  const toast = useToast()
  const [sessionsOpen, setSessionsOpen] = useState<boolean>(
    () => localStorage.getItem(SESSIONS_GROUP_KEY) !== '0',
  )
  const [materialsOpen, setMaterialsOpen] = useState<boolean>(
    () => localStorage.getItem(MATERIALS_GROUP_KEY) !== '0',
  )
  const toggleSessions = () => {
    setSessionsOpen((o) => {
      const next = !o
      localStorage.setItem(SESSIONS_GROUP_KEY, next ? '1' : '0')
      return next
    })
  }
  const toggleMaterials = () => {
    setMaterialsOpen((o) => {
      const next = !o
      localStorage.setItem(MATERIALS_GROUP_KEY, next ? '1' : '0')
      return next
    })
  }

  const q = query.trim().toLowerCase()
  const sessionsFiltered = q
    ? sessions.filter((s) =>
        (s.title ?? 'untitled session').toLowerCase().includes(q),
      )
    : sessions
  const materialsFiltered = materials
    .filter((m) => filter === 'all' || materialKind(m.source_type) === filter)
    .filter((m) =>
      q ? (m.title ?? '').toLowerCase().includes(q) : true,
    )
    // Sort case-insensitively by title so the list is easy to scan
    // alphabetically. `localeCompare` with `sensitivity: 'base'` keeps
    // accented characters next to their base form ("résumé" near
    // "resume"). Materials missing a title (rare — only mid-pipeline
    // before the rename stage finishes) sink to the bottom rather
    // than fighting for the top with a literal "Untitled" string.
    .slice()
    .sort((a, b) => {
      const at = (a.title ?? '').trim()
      const bt = (b.title ?? '').trim()
      if (!at && bt) return 1
      if (at && !bt) return -1
      if (!at && !bt) return 0
      return at.localeCompare(bt, undefined, { sensitivity: 'base' })
    })
  return (
    <aside
      aria-label="Project sessions and materials"
      className="pane ns-glass-chrome-strong"
      style={{
        width,
        borderRadius: 0,
        borderLeft: 'none',
        borderTop: 'none',
        borderBottom: 'none',
        borderColor: 'var(--color-glass-border)',
        height: '100%',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: '14px 14px 10px',
          borderBottom: '1px solid var(--color-rule)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.1em',
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
              flex: 1,
            }}
          >
            PROJECT
          </div>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Hide sidebar"
              aria-keyshortcuts="Meta+\\ Control+\\"
              title="Hide sidebar (⌘\)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 6,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-ink-2)',
                cursor: 'pointer',
              }}
            >
              <SidebarGlyph open />
            </button>
          )}
        </div>
        {/* Project name + "new project" button on one row. The dashed
            circular "+" used to open the source-upload picker, which
            doubled the Materials "+" affordance and confused users who
            expected the project header to manage *projects*, not
            sources. Now it opens the new-project dialog. Active project
            name and the new-project button share a row so the cluster
            reads as "you're in project X — add another?". Falls back
            silently when no onNewProject handler is wired (the TopBar's
            project picker also exposes "+ New project"). */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 500,
              lineHeight: 1.25,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={projectName}
          >
            {projectName}
          </div>
          {onNewProject && (
            <button
              type="button"
              onClick={() => onNewProject()}
              aria-label="Create a new project"
              title="Create a new project"
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                border: '1px dashed var(--color-rule-2)',
                background: 'transparent',
                color: 'var(--color-muted)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                flexShrink: 0,
                fontFamily: 'inherit',
                fontSize: 14,
                lineHeight: 1,
                transition: 'border-color 0.15s, color 0.15s, background 0.15s',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget
                el.style.borderColor = 'var(--color-indigo)'
                el.style.color = 'var(--color-indigo)'
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget
                el.style.borderColor = 'var(--color-rule-2)'
                el.style.color = 'var(--color-muted)'
              }}
            >
              <span aria-hidden>+</span>
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {projectTags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      </div>

      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--color-rule)',
          flexShrink: 0,
        }}
      >
        <SearchBar
          placeholder="Search this project…"
          aria-label="Search this project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="pane-body ns-steady-scroll">
        <div className="group-label">
          <button
            type="button"
            onClick={toggleSessions}
            aria-expanded={sessionsOpen}
            aria-controls="ns-side-sessions"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              color: 'inherit',
              letterSpacing: 'inherit',
              textTransform: 'inherit',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                transform: sessionsOpen ? 'none' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
              }}
            >
              <Icons.chevDown size={12} />
            </span>
            Sessions
          </button>
          <span className="count">
            {q || filter !== 'all'
              ? `${sessionsFiltered.length}/${sessions.length}`
              : sessions.length}
          </span>
          <button
            type="button"
            className="ns-btn ghost tiny"
            style={{ marginLeft: 6, padding: '2px 6px' }}
            onClick={onNewSession}
            aria-label="New session"
          >
            <Icons.plus size={12} />
          </button>
        </div>
        <div
          id="ns-side-sessions"
          style={{ padding: '0 6px 6px', display: sessionsOpen ? 'block' : 'none' }}
        >
          {sessions.length === 0 ? (
            <div
              role="status"
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--color-muted)',
              }}
            >
              No sessions yet — start one with{' '}
              <span className="font-mono">+</span>.
            </div>
          ) : sessionsFiltered.length === 0 ? (
            <div
              role="status"
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--color-muted)',
              }}
            >
              No sessions match "{query}".
            </div>
          ) : (
            <ul
              role="list"
              aria-label="Sessions"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {sessionsFiltered.map((s) => (
                <li key={s.id}>
                  <SessionRow
                    session={s}
                    active={s.id === activeSessionId}
                    onClick={() => onSelectSession(s.id)}
                    onRename={onRenameSession}
                    onDelete={onDeleteSession}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="group-label" style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={toggleMaterials}
            aria-expanded={materialsOpen}
            aria-controls="ns-side-materials"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              color: 'inherit',
              letterSpacing: 'inherit',
              textTransform: 'inherit',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                transform: materialsOpen ? 'none' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
              }}
            >
              <Icons.chevDown size={12} />
            </span>
            Materials
          </button>
          <span className="count">
            {q || filter !== 'all'
              ? `${materialsFiltered.length}/${materials.length}`
              : materials.length}
          </span>
          <button
            type="button"
            className="ns-btn ghost tiny"
            style={{ marginLeft: 6, padding: '2px 6px' }}
            onClick={() => {
              if (onAddSource) onAddSource()
              else
                toast.toast(
                  'Add a source from the chat composer — paperclip → Upload PDF.',
                )
            }}
            title="Upload PDF"
            aria-label="Upload PDF"
          >
            <Icons.plus size={12} />
          </button>
        </div>
        <div
          id="ns-side-materials"
          role="group"
          aria-label="Filter by source type"
          style={{
            display: materialsOpen ? 'flex' : 'none',
            gap: 6,
            padding: '0 14px 8px',
            flexWrap: 'wrap',
          }}
        >
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`tag ${filter === f.id ? 'solid' : ''}`}
              style={{
                fontSize: 10.5,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              aria-label={f.label}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div
          style={{
            padding: '0 6px 14px',
            display: materialsOpen ? 'block' : 'none',
          }}
        >
          {materials.length === 0 ? (
            <div
              role="status"
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--color-muted)',
              }}
            >
              No sources yet. Drop a PDF or paste a URL.
            </div>
          ) : materialsFiltered.length === 0 ? (
            <div
              role="status"
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--color-muted)',
              }}
            >
              {q ? `No materials match "${query}".` : `No ${filter} materials.`}
            </div>
          ) : (
            <ul
              role="list"
              aria-label="Materials"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {materialsFiltered.map((m) => (
                <li key={m.id}>
                  <MaterialRow
                    material={m}
                    active={m.id === activeMaterialId}
                    ingesting={ingestingIds?.has(m.id) ?? false}
                    job={ingestionJobs?.get(m.id)}
                    onClick={
                      onSelectMaterial ? () => onSelectMaterial(m.id) : undefined
                    }
                    onRename={
                      onRenameMaterial
                        ? (nextTitle) => onRenameMaterial(m.id, nextTitle)
                        : undefined
                    }
                    onDelete={
                      onDeleteMaterial
                        ? () => onDeleteMaterial(m.id, m.title)
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  )
}

function materialKind(sourceType: string): MaterialFilter {
  if (sourceType === 'pdf') return 'pdf'
  if (sourceType === 'url') return 'doc'
  return 'note'
}

function SessionRow({
  session,
  active,
  onClick,
  onRename,
  onDelete,
}: {
  session: SessionItem
  active: boolean
  onClick: () => void
  onRename?: (id: string, nextTitle: string) => void
  onDelete?: (id: string, title: string | null) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')
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
    // Only fire when the title actually changed — avoids a needless
    // PATCH when the user opens rename and just clicks away.
    if (next !== (session.title ?? '').trim() && onRename) {
      onRename(session.id, next)
    }
  }

  const hasMenu = !!onRename || !!onDelete
  const canShowMenu = hasMenu && !renaming
  const rowClassName = `row ns-side-file-row ${active ? 'active' : ''} ${menuOpen ? 'is-open' : ''} ${hasMenu ? 'ns-has-side-menu' : ''}`

  return (
    <div
      className={rowClassName}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        padding: '7px 10px',
        gap: 8,
        position: 'relative',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          marginTop: 6,
          background: active ? 'var(--color-indigo)' : 'var(--color-rule-2)',
          flexShrink: 0,
        }}
      />
      {renaming ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            ref={renameInputRef}
            className="ns-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // IME guard — Enter while composing confirms an
              // input-method candidate (e.g. a Chinese character);
              // it must not commit the rename.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(session.title ?? '')
                setRenaming(false)
              }
            }}
            onBlur={commitRename}
            placeholder="Session name…"
            aria-label={`Rename session "${session.title ?? 'Untitled session'}"`}
            style={{ fontSize: 13, padding: '3px 8px', height: 28, width: '100%' }}
          />
          <div
            className="font-mono"
            style={{
              fontSize: 10,
              color: 'var(--color-muted)',
              marginTop: 3,
            }}
          >
            Enter to save · Esc to cancel
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'true' : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'block',
              lineHeight: 1.3,
              cursor: 'pointer',
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
              font: 'inherit',
              color: 'inherit',
              padding: 0,
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: active ? 'var(--color-ink)' : 'var(--color-ink-2)',
                fontWeight: active ? 500 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {session.title ?? 'Untitled session'}
            </div>
            <div
              className="font-mono ns-side-file-meta"
              style={{
                marginTop: 2,
              }}
            >
              <span title={new Date(session.updated_at).toLocaleString()}>
                {relativeTime(session.updated_at)}
              </span>
            </div>
          </button>
          {hasMenu && (
            <div
              ref={menuWrapRef}
              className="ns-side-file-menu"
              style={{
                position: 'relative',
                flexShrink: 0,
                opacity: canShowMenu ? undefined : 0,
                visibility: canShowMenu ? 'visible' : 'hidden',
              }}
            >
              <button
                ref={menuTriggerRef}
                type="button"
                aria-label={`Session options for "${session.title ?? 'Untitled session'}"`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Rename or delete"
                style={{
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: 'none',
                  borderRadius: 5,
                  background: menuOpen ? 'rgba(14,17,22,0.06)' : 'transparent',
                  color: 'var(--color-muted)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1,
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((o) => !o)
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
                    zIndex: 30,
                  }}
                >
                  {onRename && (
                    <button
                      type="button"
                      role="menuitem"
                      className="ns-menu-item"
                      onClick={() => {
                        setMenuOpen(false)
                        setDraft(session.title ?? '')
                        setRenaming(true)
                      }}
                      style={SESSION_MENU_ITEM_STYLE}
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
                        onDelete(session.id, session.title)
                      }}
                      style={{
                        ...SESSION_MENU_ITEM_STYLE,
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

const SESSION_MENU_ITEM_STYLE: React.CSSProperties = {
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

// Stage order + labels mirror IngestionTracker. Kept local here so the
// row can render its own progress without forcing a re-export shape on
// the tracker; if either side adds a new stage, both must be updated
// (the enum on the backend is the source of truth — see migration
// 0015 / 0021).
const INGEST_STAGE_ORDER = [
  'uploaded',
  'extracting_metadata',
  'renaming',
  'chunking',
  'embedding',
  'extracting_concepts',
  'building_links',
  'building_tree',
  'ready',
] as const
const INGEST_STAGE_LABEL: Record<string, string> = {
  uploaded: 'Queued',
  extracting_metadata: 'Reading metadata',
  renaming: 'Renaming',
  chunking: 'Chunking',
  embedding: 'Embedding',
  extracting_concepts: 'Extracting concepts',
  building_links: 'Building wiki links',
  building_tree: 'Building tree index',
  ready: 'Ready',
  failed: 'Failed',
}

function MaterialRow({
  material,
  active,
  ingesting,
  job,
  onClick,
  onRename,
  onDelete,
}: {
  material: MaterialItem
  active?: boolean
  ingesting?: boolean
  /** Live ingestion job for this material, when one is in flight.
   *  Drives the inline progress bar + stage label. */
  job?: IngestionJob
  onClick?: () => void
  onRename?: (nextTitle: string) => void
  onDelete?: () => void
}) {
  const Icon =
    material.source_type === 'pdf'
      ? Icons.pdf
      : material.source_type === 'url'
        ? Icons.doc
        : Icons.note
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(material.title ?? '')
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  // Close kebab menu on outside-click / Esc — mirrors SessionRow.
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
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
    // Only fire when the title actually changed — a "rename then click
    // away" shouldn't issue a no-op PATCH (which would still bounce a
    // notesci-materials-changed event and re-pull the whole list).
    if (next !== (material.title ?? '').trim() && onRename) {
      onRename(next)
    }
  }

  const hasMenu = !!onRename || !!onDelete
  const canShowMenu = hasMenu && !renaming && !ingesting
  const rowClassName = `row ns-side-file-row ${active ? 'active' : ''} ${menuOpen ? 'is-open' : ''} ${hasMenu ? 'ns-has-side-menu' : ''}`

  // Derive what to paint for the in-flight ingest, if any. We compute
  // these here so the progress UI below the row only renders when an
  // active job exists. A clamped 0–100 percentage drives the fill bar;
  // the per-stage step index drives the chip strip + the stage label.
  const ingestStage = job?.stage as (typeof INGEST_STAGE_ORDER)[number] | 'failed' | undefined
  const ingestFailed = job?.stage === 'failed'
  const ingestReady = job?.stage === 'ready'
  // Map progress (0..1) to percent. Some early stages report 0; for
  // those we show a "thin sliver" so the bar isn't visually empty
  // while the pipeline is clearly mid-flight.
  const ingestPct = Math.max(
    8,
    Math.min(100, Math.round((job?.progress ?? 0) * 100)),
  )
  const ingestStepIdx = INGEST_STAGE_ORDER.indexOf(
    (ingestFailed ? 'building_links' : ingestStage) as (typeof INGEST_STAGE_ORDER)[number],
  )
  const ingestLabel =
    job ? (INGEST_STAGE_LABEL[job.stage] ?? 'Processing') : 'Processing'

  return (
    <div
      className={rowClassName}
      style={{
        padding: '5px 10px',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        // The global `.row` rule sets `align-items: center` — with the
        // row now being a flex column (so we can stack a progress strip
        // beneath the title row), `center` alignment lets each child
        // take its natural content width and overflow when a title is
        // long. Switch to `stretch` so the inner rows are constrained
        // to the .row's content-box width (and `minWidth: 0` on the
        // truncating descendants can do its job).
        alignItems: 'stretch',
        gap: 4,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          // Belt-and-braces: explicit full width so even if the
          // ancestor's `align-items` ever drifts back to center, the
          // inner row still spans the row's content-box and the
          // truncating button's ellipsis kicks in.
          width: '100%',
        }}
      >
      {renaming ? (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={14} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              ref={renameInputRef}
              className="ns-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // IME guard — Enter while composing confirms an
                // input-method candidate; it must not commit the rename.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDraft(material.title ?? '')
                  setRenaming(false)
                }
              }}
              onBlur={commitRename}
              placeholder="Material name…"
              aria-label={`Rename "${material.title ?? 'Untitled'}"`}
              style={{ fontSize: 12.5, padding: '3px 8px', height: 26, width: '100%' }}
            />
            <div
              className="font-mono"
              style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 3 }}
            >
              Enter to save · Esc to cancel
            </div>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            aria-current={active ? 'true' : undefined}
            title={
              ingesting
                ? `${material.title ?? 'Untitled'} — ingesting…`
                : onClick
                  ? `Open "${material.title ?? 'Untitled'}" in the reader`
                  : undefined
            }
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              textAlign: 'left',
              font: 'inherit',
              color: 'inherit',
              cursor: onClick ? 'pointer' : 'default',
            }}
          >
            <Icon size={14} />
            <span
              style={{
                flex: 1,
                fontSize: 12.5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: active ? 500 : 400,
                color: active ? 'var(--color-ink)' : undefined,
              }}
            >
              {material.title ?? 'Untitled'}
            </span>
          </button>
          <span className="ns-side-file-actions">
            {hasMenu ? (
              <div
                ref={menuWrapRef}
                className="ns-side-file-menu"
                style={{
                  position: 'relative',
                  flexShrink: 0,
                  opacity: canShowMenu ? undefined : 0,
                  visibility: canShowMenu ? 'visible' : 'hidden',
                }}
              >
                {canShowMenu && (
                  <button
                    ref={menuTriggerRef}
                    type="button"
                    aria-label={`Material options for "${material.title ?? 'Untitled'}"`}
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
                      background: menuOpen ? 'rgba(14,17,22,0.06)' : 'transparent',
                      color: 'var(--color-muted)',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icons.kebab size={14} />
                  </button>
                )}
                {menuOpen && canShowMenu && (
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
                      zIndex: 30,
                    }}
                  >
                    {onRename && (
                      <button
                        type="button"
                        role="menuitem"
                        className="ns-menu-item"
                        onClick={() => {
                          setMenuOpen(false)
                          setDraft(material.title ?? '')
                          setRenaming(true)
                        }}
                        style={SESSION_MENU_ITEM_STYLE}
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
                          ...SESSION_MENU_ITEM_STYLE,
                          color: 'var(--color-error)',
                        }}
                      >
                        <Icons.trash size={12} /> Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            <span className="ns-side-file-meta" title={new Date(material.created_at).toLocaleString()}>
              {relativeTime(material.created_at)}
            </span>
          </span>
        </>
      )}
      </div>
      {/* Inline ingestion progress strip. Renders when an active job
          exists for this material — same state machine the floating
          IngestionStrip uses, just collapsed into a per-row bar so the
          user sees progress directly where the material lives. Once
          the job hits 'ready' the strip lingers briefly (the tracker
          dismisses the job ~1.8s after completion) and then unmounts.
          Color-coded: indigo for in-progress, teal once 'ready', red on
          'failed' so a glance is enough to triage. */}
      {job && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            paddingLeft: 20, /* align under the title text, not the icon */
            paddingTop: 1,
            paddingBottom: 2,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10.5,
              fontFamily:
                'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
              letterSpacing: '0.04em',
              color: ingestFailed
                ? 'var(--color-error)'
                : ingestReady
                  ? 'var(--color-teal)'
                  : 'var(--color-indigo)',
            }}
          >
            <span>{ingestLabel.toUpperCase()}</span>
            {!ingestFailed && !ingestReady && (
              <span aria-hidden style={{ color: 'var(--color-muted-2)' }}>
                {ingestPct}%
              </span>
            )}
          </div>
          {/* Continuous fill bar — width = % progress. The pulse
              animation hints at activity when the backend hasn't yet
              reported a numeric step (early in a stage). */}
          <div
            style={{
              height: 3,
              borderRadius: 2,
              background: 'var(--color-rule-2)',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: ingestFailed
                  ? `${Math.max(8, ingestPct)}%`
                  : ingestReady
                    ? '100%'
                    : `${ingestPct}%`,
                background: ingestFailed
                  ? 'var(--color-error)'
                  : ingestReady
                    ? 'var(--color-teal)'
                    : 'var(--color-indigo)',
                transition: 'width 0.35s ease',
                animation:
                  !ingestFailed && !ingestReady
                    ? 'ns-ingestion-pulse 1.6s ease-in-out infinite'
                    : undefined,
              }}
            />
          </div>
          {/* Per-stage chips — same shape as IngestionStrip's strip. */}
          <div
            aria-hidden
            style={{ display: 'flex', gap: 2 }}
          >
            {INGEST_STAGE_ORDER.slice(0, -1).map((s, i) => {
              const passed = i <= ingestStepIdx && !ingestFailed
              const isCurrent = i === ingestStepIdx && !ingestReady && !ingestFailed
              return (
                <span
                  key={s}
                  style={{
                    flex: 1,
                    height: 2,
                    borderRadius: 1,
                    background: ingestFailed
                      ? i <= ingestStepIdx
                        ? 'var(--color-error)'
                        : 'var(--color-rule-2)'
                      : passed
                        ? 'var(--color-indigo)'
                        : 'var(--color-rule-2)',
                    opacity: isCurrent ? undefined : passed || ingestFailed ? 1 : 0.5,
                  }}
                />
              )
            })}
          </div>
          {ingestFailed && job.errorMsg && (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--color-error)',
                lineHeight: 1.4,
                marginTop: 2,
              }}
              title={job.errorMsg}
            >
              {job.errorMsg.slice(0, 80)}
              {job.errorMsg.length > 80 ? '…' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
