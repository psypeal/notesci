/**
 * Single-draft editor. Used both for chat-saved drafts and quick
 * notes the user composes manually. The drafting workflow (gather →
 * draft → polish → review) is now triggered through the chat-side
 * `/draft` slash command, so this surface is intentionally minimal:
 * title + body + a small action row.
 *
 * Editor width fills the pane (no max-width clamp) because the Draft
 * mode is now the only thing on screen — the old chat-companion
 * split was removed.
 */
import { useEffect, useRef, useState } from 'react'
import { Icons } from '../icons'
import { api } from '../../lib/api'
import { useToast } from '../Toast'
import { useConfirm } from '../../lib/useConfirm'
import { relativeTime } from '../../lib/relative-time'
import { Markdown } from '../../lib/markdown'

interface DraftState {
  title: string
  body: string
  savedAt: number
}

interface ServerDraft {
  id: string
  project_id: string
  title: string
  body: string
  updated_at: string
  created_at: string
}

export function DraftEditor({
  draftId,
  onBack,
  onDelete,
}: {
  draftId: string
  onBack: () => void
  onDelete: () => void
}) {
  // No localStorage body cache — the server is the source of truth.
  // The previous cache raced with `onSendToDraft` (a new chat-saved
  // draft would arrive on the server, then the editor's load effect
  // would overwrite it with stale localStorage data). The pointer
  // key (`notesci_active_draft_${projectId}`) is fine — it's only a
  // "which draft was open last?" hint, not draft content.
  const [draft, setDraft] = useState<DraftState>(() => ({
    title: '',
    body: '',
    savedAt: Date.now(),
  }))
  const [loading, setLoading] = useState(true)
  const [outlineOpen, setOutlineOpen] = useState(false)
  // Edit (raw textarea) vs. Preview (rendered Markdown). Drafts saved
  // from a chat reply are Markdown, so a read view matters as much as
  // the editor.
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  const toast = useToast()
  const [confirm, confirmDialog] = useConfirm()
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  // Always load from the server on mount / draft change — no fallback
  // to local cache (see comment above).
  useEffect(() => {
    let aborted = false
    setLoading(true)
    void (async () => {
      try {
        const remote = await api<ServerDraft>(`/drafts/${draftId}`, {
          auth: true,
        })
        if (aborted) return
        setDraft({
          title: remote.title,
          body: remote.body,
          savedAt: Date.parse(remote.updated_at) || Date.now(),
        })
      } catch {
        /* offline / 404 — leave the empty state, the user can re-open */
      } finally {
        if (!aborted) setLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [draftId])

  // Debounced save — server only.
  useEffect(() => {
    if (loading) return
    const t = setTimeout(() => {
      void (async () => {
        try {
          const remote = await api<ServerDraft>(`/drafts/${draftId}`, {
            method: 'PATCH',
            auth: true,
            body: JSON.stringify({ title: draft.title, body: draft.body }),
          })
          const serverSavedAt = Date.parse(remote.updated_at) || Date.now()
          setDraft((d) => ({ ...d, savedAt: serverSavedAt }))
        } catch {
          /* offline — UI keeps current text; next edit will retry */
        }
      })()
    }, 600)
    return () => clearTimeout(t)
  }, [draft.title, draft.body, draftId, loading])

  const [, force] = useState(0)
  useEffect(() => {
    let id: number | undefined
    const start = () => {
      if (id !== undefined) return
      id = window.setInterval(() => force((n) => n + 1), 1000)
    }
    const stop = () => {
      if (id === undefined) return
      window.clearInterval(id)
      id = undefined
    }
    if (document.visibilityState === 'visible') start()
    const onVis = () => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      stop()
    }
  }, [])

  const wordCount = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0
  const headings = parseHeadings(draft.body)

  const jumpTo = (offset: number) => {
    const ta = bodyRef.current
    if (!ta) return
    ta.focus()
    ta.selectionStart = offset
    ta.selectionEnd = offset
    const before = draft.body.slice(0, offset)
    const lineIndex = (before.match(/\n/g) ?? []).length
    const lineHeight = 14.5 * 1.65
    ta.scrollTop = Math.max(0, lineIndex * lineHeight - 40)
  }

  const doDelete = async () => {
    const ok = await confirm({
      title: 'Delete this draft?',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await api(`/drafts/${draftId}`, { method: 'DELETE', auth: true })
      toast.success('Draft deleted.')
      onDelete()
    } catch {
      toast.error('Could not delete the draft.')
    }
  }

  return (
    <section
      aria-label="Draft"
      className="pane"
      style={{ height: '100%', flex: 1, minWidth: 0 }}
    >
      <div className="pane-header">
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={onBack}
          aria-label="Back to drafts library"
          title="Back to drafts"
          style={{ padding: '4px 8px' }}
        >
          <Icons.chevDown
            size={12}
            style={{ transform: 'rotate(90deg)' }}
          />
        </button>
        <Icons.doc size={14} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={draft.title || undefined}
          >
            {draft.title || 'Untitled draft'}
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--color-muted)',
              letterSpacing: '0.04em',
            }}
          >
            SAVED {fmtRelative(draft.savedAt)} · {wordCount} WORDS
          </div>
        </div>
        <div
          role="toolbar"
          aria-label="Draft actions"
          style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}
        >
          {/* Edit ⇄ Preview toggle — Preview renders the body's
              Markdown (headings, lists, emphasis, code) the same way
              chat replies render, so a draft saved from a reply reads
              correctly without leaving Draft mode. */}
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setView((v) => (v === 'edit' ? 'preview' : 'edit'))}
            aria-pressed={view === 'preview'}
            title={
              view === 'edit'
                ? 'Preview the rendered draft'
                : 'Back to editing'
            }
          >
            {view === 'edit' ? (
              <>
                <Icons.eye size={11} /> Preview
              </>
            ) : (
              <>
                <Icons.doc size={11} /> Edit
              </>
            )}
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setOutlineOpen((o) => !o)}
            disabled={headings.length === 0}
            aria-pressed={outlineOpen}
            title={
              headings.length === 0
                ? 'Add ## headings to your draft to see an outline'
                : outlineOpen
                  ? 'Hide outline'
                  : 'Show outline'
            }
          >
            {outlineOpen ? 'Hide outline' : 'Outline'}
            {headings.length > 0 && (
              <span
                className="font-mono"
                style={{
                  marginLeft: 4,
                  fontSize: 10,
                  color: 'var(--color-muted)',
                }}
              >
                {headings.length}
              </span>
            )}
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => {
              const md = `# ${draft.title}\n\n${draft.body}\n`
              void navigator.clipboard.writeText(md)
              toast.success('Draft copied as Markdown.')
            }}
            title="Copy this draft to the clipboard as Markdown"
          >
            <Icons.download size={11} /> Copy
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny ns-danger-btn"
            onClick={doDelete}
            title="Delete this draft"
            aria-label="Delete draft"
          >
            <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>🗑</span>
            {' '}Delete
          </button>
        </div>
      </div>

      <div
        className="pane-body"
        style={{
          padding: '24px 40px 32px',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: '100%',
        }}
      >
        <div style={{ display: 'flex', gap: 24, flex: 1, minHeight: 0 }}>
          {outlineOpen && headings.length > 0 && (
            <aside
              aria-label="Outline"
              style={{
                width: 220,
                flexShrink: 0,
                borderRight: '1px solid var(--color-rule)',
                paddingRight: 18,
              }}
            >
              <div
                className="font-mono"
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.08em',
                  color: 'var(--color-muted)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                }}
                aria-hidden
              >
                Outline
              </div>
              <ul
                role="list"
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {headings.map((h, i) => (
                  <li
                    key={i}
                    style={{
                      paddingLeft: (h.level - 1) * 10,
                      fontSize: 12.5,
                      lineHeight: 1.4,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => jumpTo(h.offset)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        color: 'var(--color-ink-2)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 'inherit',
                        textAlign: 'left',
                        width: '100%',
                      }}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          )}

          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <input
              ref={titleRef}
              type="text"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="Untitled draft — click to name it"
              aria-label="Draft title"
              className="font-serif ns-draft-title-input"
              style={{
                fontSize: 30,
                fontWeight: 500,
                letterSpacing: '-0.02em',
                margin: '0 0 6px',
                border: 'none',
                outline: 'none',
                padding: '4px 0',
                background: 'transparent',
                color: 'var(--color-ink)',
                fontFamily: 'var(--font-serif)',
                borderBottom: '1px solid transparent',
                transition: 'border-color 0.15s',
              }}
            />
            <div
              className="font-mono"
              style={{
                fontSize: 10.5,
                color: 'var(--color-muted)',
                letterSpacing: '0.08em',
                marginBottom: 18,
                textTransform: 'uppercase',
              }}
            >
              Draft · v0.1
            </div>

            {view === 'preview' ? (
              <div
                className="font-serif md-body"
                aria-label="Draft preview"
                style={{
                  flex: 1,
                  minHeight: 320,
                  fontSize: 14.5,
                  lineHeight: 1.7,
                  color: 'var(--color-ink)',
                  overflowY: 'auto',
                }}
              >
                {draft.body.trim() ? (
                  <Markdown text={draft.body} retrieved={[]} />
                ) : (
                  <p style={{ color: 'var(--color-muted)', fontStyle: 'italic' }}>
                    Nothing to preview yet — switch to Edit and start writing.
                  </p>
                )}
              </div>
            ) : (
              <textarea
                ref={bodyRef}
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                onKeyDown={(e) => {
                  if (!(e.metaKey || e.ctrlKey)) return
                  if (e.shiftKey || e.altKey) return
                  const k = e.key.toLowerCase()
                  const wrapper = k === 'b' ? '**' : k === 'i' ? '*' : null
                  if (!wrapper) return
                  e.preventDefault()
                  const ta = e.currentTarget
                  const start = ta.selectionStart
                  const end = ta.selectionEnd
                  const before = draft.body.slice(0, start)
                  const sel = draft.body.slice(start, end)
                  const after = draft.body.slice(end)
                  const next = `${before}${wrapper}${sel}${wrapper}${after}`
                  setDraft((d) => ({ ...d, body: next }))
                  requestAnimationFrame(() => {
                    ta.selectionStart = start + wrapper.length
                    ta.selectionEnd = end + wrapper.length
                  })
                }}
                placeholder="Start writing — saves automatically every keystroke."
                aria-label="Draft body"
                className="font-serif"
                style={{
                  flex: 1,
                  minHeight: 320,
                  fontSize: 14.5,
                  lineHeight: 1.7,
                  color: 'var(--color-ink-2)',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'transparent',
                  fontFamily: 'var(--font-serif)',
                  padding: 0,
                }}
              />
            )}
          </div>
        </div>
      </div>
      {confirmDialog}
    </section>
  )
}

function parseHeadings(
  body: string,
): { level: number; text: string; offset: number }[] {
  const out: { level: number; text: string; offset: number }[] = []
  let offset = 0
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) out.push({ level: m[1].length, text: m[2], offset })
    offset += line.length + 1
  }
  return out
}

const fmtRelative = (ts: number) => relativeTime(ts, { seconds: true })
