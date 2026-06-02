/**
 * Per-project drafts library — the home view of the Draft workspace
 * mode. Lists the user's drafts as either cards (default) or a list,
 * with rename + delete actions on each entry. Also hosts the
 * "+ New draft" button for ad-hoc quick notes.
 *
 * Renders full-width within the pane (no max-width clamp) because
 * Draft mode is the only thing on screen — the old companion chat
 * split has been removed.
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { Icons } from '../icons'
import { api } from '../../lib/api'
import { SearchBar } from '../SearchBar'
import { useToast } from '../Toast'
import { useConfirm } from '../../lib/useConfirm'
import { relativeTime } from '../../lib/relative-time'

export interface DraftSummary {
  id: string
  project_id: string
  title: string
  preview: string
  updated_at: string
  created_at: string
}

interface ServerDraft {
  id: string
  project_id: string
  title: string
  body: string
  updated_at: string
  created_at: string
}

type ViewMode = 'cards' | 'list'

const VIEW_PREF_KEY = 'notesci_drafts_view'

export function DraftLibrary({
  projectId,
  onOpen,
}: {
  projectId: string | null
  onOpen: (draftId: string) => void
}) {
  const toast = useToast()
  const [confirm, confirmDialog] = useConfirm()
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<ViewMode>(() => {
    try {
      const raw = localStorage.getItem(VIEW_PREF_KEY)
      if (raw === 'cards' || raw === 'list') return raw
    } catch {
      /* ignore */
    }
    return 'cards'
  })
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) {
      setDrafts([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const remote = await api<DraftSummary[]>(
        `/projects/${projectId}/drafts`,
        { auth: true },
      )
      setDrafts(remote)
    } catch {
      /* keep last known list */
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setViewPersist = (v: ViewMode) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_PREF_KEY, v)
    } catch {
      /* ignore */
    }
  }

  const createNew = async () => {
    if (!projectId || creating) return
    setCreating(true)
    try {
      const fresh = await api<ServerDraft>(`/projects/${projectId}/drafts`, {
        method: 'POST',
        auth: true,
        body: JSON.stringify({ title: '', body: '' }),
      })
      toast.success('Blank draft created.')
      onOpen(fresh.id)
    } catch {
      toast.error("Couldn't create a new draft.")
    } finally {
      setCreating(false)
    }
  }

  const renameDraft = async (id: string, nextTitle: string) => {
    try {
      await api(`/drafts/${id}`, {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ title: nextTitle }),
      })
      setDrafts((cur) =>
        cur.map((d) => (d.id === id ? { ...d, title: nextTitle } : d)),
      )
      toast.success('Draft renamed.')
    } catch {
      toast.error("Couldn't rename the draft.")
    }
  }

  const deleteDraft = async (id: string, label: string) => {
    const ok = await confirm({
      title: `Delete "${label || 'Untitled'}"?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await api(`/drafts/${id}`, { method: 'DELETE', auth: true })
      setDrafts((cur) => cur.filter((d) => d.id !== id))
      toast.success('Draft deleted.')
    } catch {
      toast.error("Couldn't delete the draft.")
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return drafts
    return drafts.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.preview.toLowerCase().includes(q),
    )
  }, [drafts, query])

  return (
    <section
      aria-label="Drafts library"
      className="pane"
      style={{ height: '100%', flex: 1, minWidth: 0 }}
    >
      <div className="pane-header" style={{ gap: 10 }}>
        <Icons.doc size={14} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Drafts</div>
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--color-muted)',
              letterSpacing: '0.04em',
            }}
          >
            {drafts.length} {drafts.length === 1 ? 'entry' : 'entries'} in this project
          </div>
        </div>
        <div
          role="group"
          aria-label="View mode"
          style={{
            display: 'flex',
            padding: 3,
            background: 'var(--color-paper-2)',
            borderRadius: 8,
            border: '1px solid var(--color-rule)',
          }}
        >
          {(['cards', 'list'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setViewPersist(m)}
              aria-pressed={view === m}
              style={{
                padding: '4px 10px',
                fontSize: 11.5,
                borderRadius: 6,
                border: 'none',
                background: view === m ? 'var(--color-ink)' : 'transparent',
                color: view === m ? 'var(--color-paper)' : 'var(--color-ink-2)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textTransform: 'capitalize',
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ns-btn tiny"
          onClick={() => void createNew()}
          disabled={!projectId || creating}
          aria-busy={creating || undefined}
          title="Compose a new draft from scratch"
        >
          {creating ? <span className="spinner" aria-hidden /> : <Icons.plus size={12} />}
          {' '}
          New draft
        </button>
      </div>

      <div
        className="pane-body"
        style={{
          padding: '20px 32px 32px',
          background: 'var(--color-paper)',
        }}
      >
        <div
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          {drafts.length > 0 && (
            <SearchBar
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search drafts…"
              aria-label="Search drafts"
              maxWidth={320}
            />
          )}

          {loading && drafts.length === 0 ? (
            <div
              role="status"
              style={{
                fontSize: 13,
                color: 'var(--color-muted)',
                padding: '40px 0',
                textAlign: 'center',
              }}
            >
              Loading drafts…
            </div>
          ) : drafts.length === 0 ? (
            <EmptyState onNew={() => void createNew()} disabled={!projectId} />
          ) : view === 'cards' ? (
            <CardsView
              drafts={filtered}
              onOpen={onOpen}
              renamingId={renamingId}
              onStartRename={setRenamingId}
              onCommitRename={(id, title) => {
                setRenamingId(null)
                void renameDraft(id, title)
              }}
              onCancelRename={() => setRenamingId(null)}
              onDelete={deleteDraft}
            />
          ) : (
            <ListView
              drafts={filtered}
              onOpen={onOpen}
              renamingId={renamingId}
              onStartRename={setRenamingId}
              onCommitRename={(id, title) => {
                setRenamingId(null)
                void renameDraft(id, title)
              }}
              onCancelRename={() => setRenamingId(null)}
              onDelete={deleteDraft}
            />
          )}
        </div>
      </div>
      {confirmDialog}
    </section>
  )
}

interface EntryActionProps {
  drafts: DraftSummary[]
  onOpen: (id: string) => void
  renamingId: string | null
  onStartRename: (id: string) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
  onDelete: (id: string, label: string) => void
}

function CardsView(props: EntryActionProps) {
  const {
    drafts,
    onOpen,
    renamingId,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onDelete,
  } = props
  if (drafts.length === 0) {
    return (
      <div
        style={{
          fontSize: 13,
          color: 'var(--color-muted)',
          padding: '20px 0',
          textAlign: 'center',
        }}
      >
        No matching drafts.
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 14,
      }}
    >
      {drafts.map((d) => {
        const isRenaming = renamingId === d.id
        return (
          <div
            key={d.id}
            className="ns-draft-card"
            role="group"
            aria-label={d.title || 'Untitled draft'}
            tabIndex={isRenaming ? -1 : 0}
            onClick={(e) => {
              // Don't navigate when clicking on inner controls.
              if ((e.target as HTMLElement).closest('button, input')) return
              if (isRenaming) return
              onOpen(d.id)
            }}
            onKeyDown={(e) => {
              if (isRenaming) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen(d.id)
              }
            }}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              background: '#fff',
              border: '1px solid var(--color-rule)',
              borderRadius: 12,
              cursor: isRenaming ? 'default' : 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minHeight: 160,
              transition:
                'border-color 0.12s, box-shadow 0.12s, transform 0.12s',
              position: 'relative',
            }}
          >
            {isRenaming ? (
              <RenameInput
                initial={d.title}
                onCommit={(t) => onCommitRename(d.id, t)}
                onCancel={onCancelRename}
              />
            ) : (
              <div
                className="font-serif"
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  lineHeight: 1.25,
                  color: 'var(--color-ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
                title={d.title || 'Untitled'}
              >
                {d.title || 'Untitled'}
              </div>
            )}
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--color-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                flex: 1,
              }}
            >
              {d.preview || <em style={{ opacity: 0.6 }}>Empty draft</em>}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 4,
              }}
            >
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  color: 'var(--color-muted)',
                  textTransform: 'uppercase',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {relativeTime(d.updated_at)}
              </span>
              <EntryActionRow
                draftId={d.id}
                label={d.title}
                isRenaming={isRenaming}
                onStartRename={onStartRename}
                onDelete={onDelete}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ListView(props: EntryActionProps) {
  const {
    drafts,
    onOpen,
    renamingId,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onDelete,
  } = props
  if (drafts.length === 0) {
    return (
      <div
        style={{
          fontSize: 13,
          color: 'var(--color-muted)',
          padding: '20px 0',
          textAlign: 'center',
        }}
      >
        No matching drafts.
      </div>
    )
  }
  return (
    <ul
      role="list"
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {drafts.map((d, i) => {
        const isRenaming = renamingId === d.id
        return (
          <li
            key={d.id}
            style={{
              borderTop: i === 0 ? 'none' : '1px solid var(--color-rule)',
              position: 'relative',
            }}
          >
            <div
              className="ns-draft-row"
              role="button"
              tabIndex={isRenaming ? -1 : 0}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button, input')) return
                if (isRenaming) return
                onOpen(d.id)
              }}
              onKeyDown={(e) => {
                if (isRenaming) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(d.id)
                }
              }}
              style={{
                width: '100%',
                padding: '12px 16px',
                background: 'transparent',
                border: 'none',
                cursor: isRenaming ? 'default' : 'pointer',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                textAlign: 'left',
              }}
            >
              <Icons.doc size={14} />
              <div style={{ minWidth: 0, flex: 1 }}>
                {isRenaming ? (
                  <RenameInput
                    initial={d.title}
                    onCommit={(t) => onCommitRename(d.id, t)}
                    onCancel={onCancelRename}
                  />
                ) : (
                  <div
                    className="font-serif"
                    style={{
                      fontSize: 14.5,
                      fontWeight: 500,
                      lineHeight: 1.3,
                      color: 'var(--color-ink)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.title || 'Untitled'}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--color-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {d.preview || 'Empty draft'}
                </div>
              </div>
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  color: 'var(--color-muted)',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                }}
              >
                {relativeTime(d.updated_at)}
              </span>
              <EntryActionRow
                draftId={d.id}
                label={d.title}
                isRenaming={isRenaming}
                onStartRename={onStartRename}
                onDelete={onDelete}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function EntryActionRow({
  draftId,
  label,
  isRenaming,
  onStartRename,
  onDelete,
}: {
  draftId: string
  label: string
  isRenaming: boolean
  onStartRename: (id: string) => void
  onDelete: (id: string, label: string) => void
}) {
  if (isRenaming) return null
  return (
    <div
      className="ns-draft-actions"
      style={{
        display: 'flex',
        gap: 4,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        className="ns-btn ghost tiny ns-draft-action"
        onClick={(e) => {
          e.stopPropagation()
          onStartRename(draftId)
        }}
        title="Rename"
        aria-label="Rename draft"
      >
        <Icons.note size={11} />
      </button>
      <button
        type="button"
        className="ns-btn ghost tiny ns-draft-action ns-danger-btn"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(draftId, label)
        }}
        title="Delete"
        aria-label="Delete draft"
      >
        <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>🗑</span>
      </button>
    </div>
  )
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(e) => {
        // IME guard — Enter while composing confirms an input-method
        // candidate (e.g. a Chinese character); it must not commit
        // the rename.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value.trim())
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      aria-label="Rename draft"
      className="ns-input"
      style={{
        fontSize: 14,
        padding: '6px 8px',
        width: '100%',
        fontFamily: 'var(--font-serif)',
      }}
    />
  )
}

function EmptyState({
  onNew,
  disabled,
}: {
  onNew: () => void
  disabled: boolean
}) {
  return (
    <div
      style={{
        padding: '64px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
      }}
    >
      <h3
        className="font-serif"
        style={{
          fontSize: 24,
          fontWeight: 500,
          letterSpacing: '-0.01em',
          margin: 0,
          color: 'var(--color-ink)',
        }}
      >
        No drafts yet
      </h3>
      <p
        style={{
          fontSize: 13.5,
          lineHeight: 1.55,
          color: 'var(--color-ink-2)',
          maxWidth: 380,
          margin: 0,
        }}
      >
        Save replies from a chat session, or start a quick note here.
        Drafts are private and stay in this project.
      </p>
      <button
        type="button"
        className="ns-btn"
        onClick={onNew}
        disabled={disabled}
        style={{ marginTop: 6 }}
      >
        <Icons.plus size={12} /> New draft
      </button>
    </div>
  )
}
