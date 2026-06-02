/**
 * General page — the first surface users see after sign-in.
 *
 * Two states, same page:
 *   - LANDING (no ?s= in URL): centered title + composer, nothing else.
 *     Per the design choice that first-touch should feel calm, not busy.
 *   - ACTIVE  (?s=<session_id>): messages list above + composer at
 *     bottom. Refresh-safe — the session id lives in the URL so
 *     bookmark / reload restores the thread via /threads/:id/messages.
 *
 * Submitting on LANDING:
 *   1. POST /general/sessions  → new general session in the workspace
 *   2. URL replaces to /?s=<id>
 *   3. POST /chat with thread_id → AI reply
 *   4. Page is now in ACTIVE state with both bubbles rendered
 *
 * Submitting on ACTIVE:
 *   POST /chat with the existing thread_id; append both bubbles.
 *
 * No web-search toggle, no attachments, no /commands yet — those wire
 * up in a later slice once the project-chat redesign lands and we can
 * share a single composer component across both surfaces.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Lockup } from '../components/brand/Lockup'
import { Icons } from '../components/icons'
import { Mark } from '../components/brand/Mark'
import { Markdown } from '../lib/markdown'
import { SidebarGlyph } from '../components/workspace/TopBar'
import { ModelPill } from '../components/workspace/ModelPill'
import { api, apiSse, errorMessage, type ApiError } from '../lib/api'
import { handleMcpLinkInstall } from '../lib/mcpLinks'
import { getProviders, resolveActiveModel } from '../lib/models'
import { patchPrefs, readPrefs } from '../lib/prefs'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Module-level worker registration. Idempotent — if PdfReader has
// already mounted (its module-load also sets workerSrc to the same
// URL) this is a no-op.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc

/** Client-side PDF → text. Used by the per-turn attachment flow in
 *  general chat: extract once, prepend into the next outgoing message,
 *  no project / no materials row. */
async function extractPdfText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjsLib.getDocument({ data: buf }).promise
  try {
    const parts: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const text = content.items
        .map((it) => ('str' in it ? (it as { str: string }).str : ''))
        .join(' ')
      parts.push(text)
    }
    return parts.join('\n\n').replace(/[ \t]+/g, ' ').trim()
  } finally {
    await doc.destroy()
  }
}
import { initialsFor } from '../lib/initials'
import { useToast } from '../components/Toast'
import { useConfirm } from '../lib/useConfirm'
import { usePageTitle } from '../lib/title'
import { relativeTime } from '../lib/relative-time'

type SessionListItem = SessionOut

interface MeOut {
  id: string
  workspace_id: string
  email: string
  display_name: string | null
  email_verified: boolean
}

interface ProjectOut {
  id: string
  workspace_id: string
  name: string
  created_at: string
  updated_at: string
}

interface SessionOut {
  id: string
  project_id: string | null
  kind: string
  title: string | null
  created_at: string
  updated_at: string
}

interface ThreadMessagesOut {
  thread_id: string
  messages: {
    role: 'human' | 'ai' | 'tool' | 'system'
    content: string
    turn_seq?: number
    model?: string | null
  }[]
}

interface Msg {
  role: 'human' | 'ai'
  content: string
  // turn_seq lets us key reliably across optimistic updates + reloads.
  turn_seq?: number
}

export function GeneralPage() {
  usePageTitle('notesci')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const [me, setMe] = useState<MeOut | null>(null)
  const [projects, setProjects] = useState<ProjectOut[]>([])
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)

  // sessionId comes from ?s=<uuid> on first paint so refresh restores the
  // active chat. setSessionUrl() is the canonical way to mutate it: it
  // updates state AND the URL in lockstep so the back button works.
  const initialSessionId = searchParams.get('s')
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId)
  const [messages, setMessages] = useState<Msg[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [sending, setSending] = useState(false)
  // Left-rail session list. ``sidebarOpen`` persists so the user's
  // last collapse-state is honoured across reloads.
  const SIDEBAR_KEY = 'notesci_general_sidebar_open'
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) !== '0',
  )
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  // Per-turn file attachment queued for the next message. PDF text is
  // extracted client-side via pdfjs (no backend round-trip) and
  // prepended to the outgoing user message body. Cleared after send.
  // No project is created and no material is indexed — this is
  // ephemeral context for one turn only, matching ChatGPT / Claude.ai
  // semantics for inline file drops in conversational chat.
  interface Attachment {
    name: string
    text: string
    chars: number
  }
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [attaching, setAttaching] = useState(false)

  // Per-composer model selection — same contract as project ChatPane:
  // initialise from the saved pref (canonical "<provider>:<model_id>" or
  // null = "server default") and keep the pref + the in-composer
  // ModelPill in sync. Without this, general chat silently used the
  // server default with no way to switch even when several providers
  // were configured.
  const [selectedModel, setSelectedModel] = useState<string | null>(
    () => readPrefs().defaultModel,
  )
  const updateSelectedModel = (next: string | null) => {
    setSelectedModel(next)
    patchPrefs('defaultModel', next)
  }
  // Warm the provider catalog so the ModelPill can decide whether to
  // render (it hides itself when ≤1 model is available).
  useEffect(() => {
    void getProviders().catch(() => {
      /* offline / no providers — pill stays hidden, server default used */
    })
  }, [])
  const resolveModelForRequest = async (): Promise<string | null> => {
    const catalog = await getProviders().catch(() => null)
    return resolveActiveModel(selectedModel, catalog)
  }

  const handleMarkdownLinkClick = (href: string) => {
    return handleMcpLinkInstall(href).then((result) => {
      if (result.handled && result.message && result.tone) {
        const tones = {
          success: toast.success,
          warn: toast.warn,
          error: toast.error,
          info: toast.toast,
        }

        tones[result.tone]?.(result.message)
      }
      return !result.open
    })
  }

  // Load identity, projects, general sessions list. Identity is loaded
  // once on mount; sessions get refreshed after every send so the
  // newly-created thread shows up in the sidebar.
  const refreshSessions = useCallback(async () => {
    try {
      const list = await api<SessionListItem[]>('/general/sessions', {
        auth: true,
      })
      setSessions(list)
    } catch {
      /* non-fatal — sidebar just stays empty */
    } finally {
      setSessionsLoaded(true)
    }
  }, [])
  useEffect(() => {
    void (async () => {
      try {
        const meRes = await api<MeOut>('/me', { auth: true })
        setMe(meRes)
      } catch (e) {
        if ((e as ApiError | undefined)?.status !== 401) {
          toast.warn('Could not load your profile.')
        }
      }
      try {
        const projRes = await api<ProjectOut[]>('/projects', { auth: true })
        setProjects(projRes)
      } catch {
        /* non-essential */
      }
      void refreshSessions()
    })()
  }, [toast, refreshSessions])

  // Refresh-restore: when the page mounts with ?s= in the URL, fetch
  // the past messages so the user picks up where they left off.
  useEffect(() => {
    if (!sessionId) return
    setHistoryLoading(true)
    void (async () => {
      try {
        const h = await api<ThreadMessagesOut>(
          `/threads/${sessionId}/messages`,
          { auth: true },
        )
        const restored: Msg[] = h.messages
          .filter((m) => m.role === 'human' || m.role === 'ai')
          .map((m) => ({
            role: m.role as 'human' | 'ai',
            content: m.content,
            turn_seq: m.turn_seq,
          }))
        setMessages(restored)
      } catch (e) {
        const err = e as ApiError | undefined
        if (err?.status === 404) {
          // Stale URL — session no longer exists or isn't ours. Clear.
          toast.warn('That conversation could not be loaded.')
          setSessionId(null)
          const next = new URLSearchParams(searchParams)
          next.delete('s')
          setSearchParams(next, { replace: true })
        } else if (err?.status !== 401) {
          toast.warn('Could not load conversation history.')
        }
      } finally {
        setHistoryLoading(false)
      }
    })()
    // Re-run only when sessionId changes — the searchParams reference
    // is unstable across renders and would over-fire this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Click-outside close for both top-bar menus.
  const navRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!navRef.current) return
      if (!navRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false)
        setAvatarMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Single submit path used by both the landing composer and the
  // active-chat composer. Creates the session on first message; reuses
  // it after. Optimistically appends the user bubble so the page feels
  // responsive while /chat is in flight.
  const onSubmit = useCallback(
    async (text: string) => {
      if (sending) return
      setSending(true)
      let activeSid = sessionId

      // Compose the outgoing message body. When an attachment is
      // queued, prepend its extracted text inside a clearly-delimited
      // block so the model can tell user prose from file content. The
      // visible bubble in the UI shows the user's own words only
      // (without the bulky attachment dump) so the conversation stays
      // readable.
      const queued = attachment
      const outgoing = queued
        ? `[Attached file: ${queued.name}]\n\n` +
          `<<<FILE_START>>>\n${queued.text}\n<<<FILE_END>>>\n\n` +
          `---\n\n${text}`
        : text
      const displayed = queued
        ? `📎 ${queued.name}\n\n${text}`
        : text

      // Optimistic user message — keep regardless of which branch we
      // hit so the user sees their own words while the AI is thinking.
      const userMsg: Msg = { role: 'human', content: displayed }
      setMessages((prev) => [...prev, userMsg])
      const ac = new AbortController()
      abortRef.current = ac

      try {
        if (!activeSid) {
          // First send — mint the general session before /chat.
          const sess = await api<SessionOut>('/general/sessions', {
            method: 'POST',
            auth: true,
            body: JSON.stringify({}),
          })
          activeSid = sess.id
          setSessionId(sess.id)
          const next = new URLSearchParams(searchParams)
          next.set('s', sess.id)
          setSearchParams(next, { replace: true })
        }
        let aiStarted = false
        let reply = ''
        let turnSeq: number | undefined
        let flushTimer: number | null = null
        const flushReply = () => {
          flushTimer = null
          if (!aiStarted) {
            aiStarted = true
            setMessages((prev) => [...prev, { role: 'ai', content: reply }])
          } else {
            setMessages((prev) =>
              prev.map((m, i) =>
                i === prev.length - 1 && m.role === 'ai'
                  ? { ...m, content: reply }
                  : m,
              ),
            )
          }
        }
        const scheduleFlush = () => {
          if (flushTimer != null) return
          flushTimer = window.setTimeout(flushReply, 50)
        }
        const modelToSend = await resolveModelForRequest()
        await apiSse('/chat/stream', {
          method: 'POST',
          auth: true,
          body: JSON.stringify({
            thread_id: activeSid,
            message: outgoing,
            model: modelToSend,
          }),
          signal: ac.signal,
        }, (event) => {
          if (event.type === 'token' && typeof event.text === 'string') {
            reply += event.text
            scheduleFlush()
          }
          if (event.type === 'done') {
            if (!aiStarted && typeof event.final_text === 'string' && event.final_text) {
              reply = event.final_text
            }
            if (flushTimer != null) {
              window.clearTimeout(flushTimer)
              flushReply()
            } else if (!aiStarted && reply) {
              flushReply()
            }
            turnSeq = typeof event.turn_seq === 'number' ? event.turn_seq : undefined
            setMessages((prev) =>
              prev.map((m, i) =>
                i === prev.length - 1 && m.role === 'ai'
                  ? { ...m, turn_seq: turnSeq }
                  : m,
              ),
            )
          }
        })
        // Attachment was successfully consumed by this turn — clear so
        // the next message doesn't accidentally re-send it.
        if (queued) setAttachment(null)
        // Refresh the sidebar so the new (or title-updated) session
        // appears immediately. Best-effort; failure just leaves the
        // list stale until the next reload.
        void refreshSessions()
      } catch (e) {
        const err = e as ApiError | undefined
        if (err?.code === 'aborted' || err?.name === 'AbortError') {
          return
        }
        // Roll back the optimistic user bubble on failure so the user
        // isn't looking at their unanswered words next to a toast.
        setMessages((prev) => prev.slice(0, -1))
        if (err?.status !== 401) {
          toast.warn(err?.message ?? 'Could not send your message.')
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null
        setSending(false)
      }
    },
    [sending, sessionId, searchParams, setSearchParams, toast, refreshSessions, attachment, selectedModel],
  )

  // Per-turn file attachment.
  //
  // First (broken) shape spun up a project + navigated to /p/:id —
  // wrong mental model, the user wanted to stay in general chat. This
  // version extracts PDF text client-side via pdfjs and stores it as
  // an Attachment; the next outgoing message prepends the extracted
  // text. No backend changes, no project, no navigation.
  //
  // Only one attachment can be queued at a time — re-attaching
  // overwrites the previous queue. Multi-file would need a chip-list
  // and concatenation, which is a separate polish slice.
  const onAttachInGeneral = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const file = files[0]
      setAttaching(true)
      try {
        const text = await extractPdfText(file)
        if (!text) {
          toast.warn(
            `Couldn't read any text from ${file.name}. Scanned PDFs need OCR — open a project to ingest them via the materials path.`,
          )
          return
        }
        setAttachment({ name: file.name, text, chars: text.length })
        toast.success(
          `Attached "${file.name}" (${text.length.toLocaleString()} chars). Send your next message to include it.`,
        )
      } catch (err) {
        toast.error(
          errorMessage(err, `Couldn't read ${file.name}.`),
        )
      } finally {
        setAttaching(false)
      }
    },
    [toast],
  )

  const clearAttachment = useCallback(() => setAttachment(null), [])

  const startNewChat = useCallback(() => {
    setSessionId(null)
    setMessages([])
    const next = new URLSearchParams(searchParams)
    next.delete('s')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const openSession = useCallback(
    (id: string) => {
      if (id === sessionId) return
      setSessionId(id)
      setMessages([])
      const next = new URLSearchParams(searchParams)
      next.set('s', id)
      setSearchParams(next, { replace: true })
    },
    [sessionId, searchParams, setSearchParams],
  )

  const deleteSession = useCallback(
    async (id: string, title: string | null) => {
      const label = (title ?? '').trim() || 'this chat'
      const ok = await confirm({
        title: `Delete "${label}"?`,
        description: 'This removes the conversation and its citations. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      })
      if (!ok) return
      try {
        await api(`/sessions/${id}`, { method: 'DELETE', auth: true })
        setSessions((cur) => cur.filter((s) => s.id !== id))
        if (sessionId === id) startNewChat()
        toast.success(`Deleted "${label}".`)
      } catch (e) {
        const err = e as ApiError | undefined
        toast.error(err?.message ?? "Couldn't delete that chat.")
      }
    },
    [confirm, sessionId, startNewChat, toast],
  )

  // Optimistic rename: PATCH /sessions/:id with the new title, mirror
  // the change in the sidebar list, roll back on failure. Empty /
  // whitespace-only titles reset server-side to NULL so the row falls
  // back to its "Untitled chat" label.
  const renameSession = useCallback(
      async (id: string, nextTitle: string) => {
        const prev = sessions
        const trimmed = nextTitle.trim()
        setSessions((cur) =>
          cur.map((s) => (s.id === id ? { ...s, title: trimmed || null } : s)),
        )
        try {
          await api(`/sessions/${id}`, {
            method: 'PATCH',
            auth: true,
            body: JSON.stringify({ title: trimmed }),
          })
        } catch (e) {
          setSessions(prev)
          const err = e as ApiError | undefined
          toast.error(err?.message ?? "Couldn't rename that chat.")
        }
      },
      [sessions, toast],
    )

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((cur) => {
      const next = !cur
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  const isActive = sessionId !== null

  return (
    <div
      style={{
        height: '100vh',
        // Transparent so the body's brand-tinted radial wash bleeds
        // through to the chrome's backdrop-filter — otherwise the
        // glass surfaces blur a solid paper plate and the wash is
        // invisible. Message panes keep their opaque #fff background
        // from .pane so reading legibility is unaffected.
        background: 'transparent',
        color: 'var(--color-ink)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <header
        className="ns-glass-chrome"
        style={{
          height: 56,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          borderBottom: '1px solid var(--color-glass-border-soft)',
          gap: 12,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Link
          to="/"
          aria-label="notesci · new general chat"
          onClick={(e) => {
            // Cmd/Ctrl-click respects browser behavior (new tab).
            if (e.metaKey || e.ctrlKey) return
            // Clean reset to landing: clear ?s=, drop messages.
            if (sessionId) {
              e.preventDefault()
              setSessionId(null)
              setMessages([])
              const next = new URLSearchParams(searchParams)
              next.delete('s')
              setSearchParams(next, { replace: true })
            }
          }}
          style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
        >
          <Lockup size={18} />
        </Link>

        <div style={{ flex: 1 }} />

        <div ref={navRef} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
          {/* "New chat" lives in the left sessions sidebar — keeping
              the header lean for project switch + account. */}

          <button
            type="button"
            onClick={() => {
              setProjectMenuOpen((v) => !v)
              setAvatarMenuOpen(false)
            }}
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            className="ns-btn ghost"
            style={{
              height: 32,
              padding: '0 12px',
              fontSize: 13,
              gap: 6,
              borderColor: 'var(--color-rule)',
            }}
          >
            <Icons.folder size={13} />
            Open a project
            <Icons.chevDown size={11} />
          </button>

          {projectMenuOpen && (
            <ProjectMenu
              projects={projects}
              onPick={(id) => {
                setProjectMenuOpen(false)
                navigate(`/p/${id}`)
              }}
              onClose={() => setProjectMenuOpen(false)}
            />
          )}

          <button
            type="button"
            onClick={() => {
              setAvatarMenuOpen((v) => !v)
              setProjectMenuOpen(false)
            }}
            aria-haspopup="menu"
            aria-expanded={avatarMenuOpen}
            aria-label="Account menu"
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              border: 'none',
              background: 'var(--color-indigo)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {me ? initialsFor(me.display_name, me.email) : '·'}
          </button>

          {avatarMenuOpen && (
            <AvatarMenu
              me={me}
              onClose={() => setAvatarMenuOpen(false)}
            />
          )}
        </div>
      </header>

      <div
        style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
        }}
      >
        <SessionsSidebar
          open={sidebarOpen}
          onToggle={toggleSidebar}
          sessions={sessions}
          loaded={sessionsLoaded}
          activeId={sessionId}
          onNewChat={startNewChat}
          onPick={openSession}
          onRename={renameSession}
          onDelete={deleteSession}
        />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {isActive ? (
            <ActiveChat
              messages={messages}
              historyLoading={historyLoading}
              sending={sending}
              onSubmit={onSubmit}
              onStop={() => abortRef.current?.abort()}
              onUpload={onAttachInGeneral}
              attachment={attachment}
              attaching={attaching}
              onRemoveAttachment={clearAttachment}
              onLinkClick={handleMarkdownLinkClick}
              model={selectedModel}
              onModelChange={updateSelectedModel}
            />
          ) : (
            <LandingHero
              sending={sending}
              onSubmit={onSubmit}
              onStop={() => abortRef.current?.abort()}
              onUpload={onAttachInGeneral}
              attachment={attachment}
              attaching={attaching}
              onRemoveAttachment={clearAttachment}
              model={selectedModel}
              onModelChange={updateSelectedModel}
            />
          )}
        </div>
      </div>
      {confirmDialog}
    </div>
  )
}

/* ============================================================ */
/* Sessions sidebar — list past chats + new + delete             */
/* ============================================================ */

function SessionsSidebar({
  open,
  onToggle,
  sessions,
  loaded,
  activeId,
  onNewChat,
  onPick,
  onRename,
  onDelete,
}: {
  open: boolean
  onToggle: () => void
  sessions: SessionListItem[]
  loaded: boolean
  activeId: string | null
  onNewChat: () => void
  onPick: (id: string) => void
  onRename: (id: string, nextTitle: string) => void
  onDelete: (id: string, title: string | null) => void
}) {
  // Collapsed: a slim rail with just a toggle + new-chat icon, so the
  // chat surface gets the full width when the user wants focus.
  if (!open) {
    return (
      <aside
        className="ns-glass-chrome"
        aria-label="Chat history"
        style={{
          width: 44,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          padding: '12px 0',
          borderRight: '1px solid var(--color-glass-border-soft)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label="Show chat history"
          aria-keyshortcuts="Meta+\\ Control+\\"
          title="Show chat history (⌘\)"
          className="ns-btn ghost tiny"
          style={{
            width: 30,
            height: 30,
            padding: 0,
            justifyContent: 'center',
            color: 'var(--color-ink-2)',
          }}
        >
          <SidebarGlyph open={false} />
        </button>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="ns-btn ghost tiny"
          style={{ width: 30, height: 30, padding: 0, justifyContent: 'center' }}
        >
          <Icons.plus size={14} />
        </button>
      </aside>
    )
  }
  return (
    <aside
      className="ns-glass-chrome-strong"
      aria-label="Chat history"
      style={{
        width: 260,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--color-glass-border)',
        flexShrink: 0,
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px 8px',
        }}
      >
        <div
          className="font-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: '0.1em',
            color: 'var(--color-muted)',
            textTransform: 'uppercase',
            flex: 1,
          }}
        >
          Chats
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Hide chat history"
          aria-keyshortcuts="Meta+\\ Control+\\"
          title="Hide chat history (⌘\)"
          className="ns-btn ghost tiny"
          style={{
            width: 26,
            height: 26,
            padding: 0,
            justifyContent: 'center',
            color: 'var(--color-ink-2)',
          }}
        >
          <SidebarGlyph open />
        </button>
      </div>
      <div style={{ padding: '0 8px 8px' }}>
        <button
          type="button"
          onClick={onNewChat}
          className="ns-btn"
          style={{
            width: '100%',
            height: 32,
            padding: '0 12px',
            fontSize: 12.5,
            gap: 6,
            justifyContent: 'center',
            background: 'var(--color-paper-2)',
            color: 'var(--color-ink)',
            border: '1px dashed var(--color-rule-2)',
          }}
        >
          <Icons.plus size={12} /> New chat
        </button>
      </div>
      <div
        className="ns-steady-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 6px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minHeight: 0,
        }}
      >
        {!loaded ? (
          <div
            style={{
              padding: '14px 8px',
              fontSize: 12.5,
              color: 'var(--color-muted)',
            }}
          >
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div
            style={{
              padding: '14px 8px',
              fontSize: 12.5,
              color: 'var(--color-muted)',
              lineHeight: 1.55,
            }}
          >
            No chats yet. Send a message to start one.
          </div>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              onPick={() => onPick(s.id)}
              onRename={(nextTitle) => onRename(s.id, nextTitle)}
              onDelete={() => onDelete(s.id, s.title)}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function SessionRow({
  session,
  active,
  onPick,
  onRename,
  onDelete,
}: {
  session: SessionListItem
  active: boolean
  onPick: () => void
  onRename: (nextTitle: string) => void
  onDelete: () => void
}) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const title = (session.title ?? '').trim() || 'Untitled chat'

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
  // Also resets the finalize-once guard so a subsequent rename works.
  const finalizingRef = useRef(false)
  useEffect(() => {
    if (renaming) {
      finalizingRef.current = false
      const el = renameInputRef.current
      el?.focus()
      el?.select()
    }
  }, [renaming])

  // Enter -> commitRename -> setRenaming(false) unmounts the <input>,
  // which fires onBlur -> commitRename a second time. Without a guard
  // the prop-level `session.title` hasn't propagated yet, so the early-
  // exit still sees a "changed" title and PATCHes twice. The ref runs
  // once per rename session; useEffect above resets it on each entry.
  const commitRename = () => {
    if (finalizingRef.current) return
    finalizingRef.current = true
    const next = draft.trim()
    setRenaming(false)
    // Only fire when the title actually changed — avoids a needless
    // PATCH when the user opens rename and just clicks away.
    if (next !== (session.title ?? '').trim()) {
      onRename(next)
    }
  }
  const cancelRename = () => {
    finalizingRef.current = true
    setDraft(session.title ?? '')
    setRenaming(false)
  }

  const showKebab = !renaming && (hover || active || menuOpen)

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px',
        borderRadius: 6,
        background: active
          ? 'color-mix(in oklch, var(--color-indigo) 12%, transparent)'
          : hover
            ? 'var(--color-paper-2)'
            : 'transparent',
        cursor: renaming ? 'default' : 'pointer',
        position: 'relative',
      }}
      onClick={() => {
        if (renaming) return
        onPick()
      }}
      onDoubleClick={(e) => {
        // Double-click the row to start renaming, in addition to the
        // kebab → Rename path. Matches the IME-guarded input below.
        e.stopPropagation()
        setDraft(session.title ?? '')
        setRenaming(true)
      }}
    >
      {renaming ? (
        <div
          style={{ flex: 1, minWidth: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
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
                cancelRename()
              }
            }}
            onBlur={commitRename}
            placeholder="Chat name…"
            aria-label={`Rename chat "${title}"`}
            style={{ fontSize: 13, padding: '3px 8px', height: 28, width: '100%' }}
          />
          <div
            className="font-mono"
            style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 3 }}
          >
            Enter to save · Esc to cancel
          </div>
        </div>
      ) : (
        <>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span
              style={{
                fontSize: 13,
                color: 'var(--color-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={title}
            >
              {title}
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 10.5, color: 'var(--color-muted)' }}
            >
              {relativeTime(session.updated_at)}
            </span>
          </div>
          <div ref={menuWrapRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              ref={menuTriggerRef}
              type="button"
              aria-label={`Chat options for "${title}"`}
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
                  zIndex: 30,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="ns-menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    setDraft(session.title ?? '')
                    setRenaming(true)
                  }}
                  style={{
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
                  }}
                >
                  <Icons.doc size={12} /> Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ns-menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    onDelete()
                  }}
                  style={{
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
                    color: 'var(--color-error)',
                  }}
                >
                  <Icons.trash size={12} /> Delete
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* ============================================================ */
/* Landing state — centered title + composer                    */
/* ============================================================ */

interface AttachProps {
  attachment?: { name: string; chars: number } | null
  attaching?: boolean
  onRemoveAttachment?: () => void
}

function LandingHero({
  sending,
  onSubmit,
  onStop,
  onUpload,
  attachment,
  attaching,
  onRemoveAttachment,
  model,
  onModelChange,
}: {
  sending: boolean
  onSubmit: (text: string) => void
  onStop?: () => void
  onUpload?: (files: File[]) => Promise<void> | void
  model?: string | null
  onModelChange?: (next: string | null) => void
} & AttachProps) {
  return (
    <main
      className="ns-chat-surface"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 768, textAlign: 'center' }}>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 'clamp(28px, 4vw, 40px)',
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            margin: '0 0 28px',
            fontWeight: 400,
            color: 'var(--color-ink)',
          }}
        >
          What are you looking into{' '}
          <em style={{ fontStyle: 'italic', color: 'var(--color-indigo)' }}>today</em>?
        </h1>

        {attachment && (
          <AttachmentChip
            attachment={attachment}
            onRemove={onRemoveAttachment}
          />
        )}
        <Composer
          onSubmit={onSubmit}
          onStop={onStop}
          onUpload={onUpload}
          sending={sending}
          attaching={attaching}
          model={model}
          onModelChange={onModelChange}
          placeholder="Ask anything — start a thread."
        />
      </div>
    </main>
  )
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: { name: string; chars: number }
  onRemove?: () => void
}) {
  return (
    <div
      role="status"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px 6px 12px',
        marginBottom: 10,
        background: 'color-mix(in oklch, var(--color-indigo) 10%, transparent)',
        border: '1px solid color-mix(in oklch, var(--color-indigo) 40%, transparent)',
        borderRadius: 999,
        fontSize: 12.5,
        color: 'var(--color-indigo)',
        maxWidth: '100%',
      }}
    >
      <span aria-hidden>📎</span>
      <span
        style={{
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 300,
        }}
        title={attachment.name}
      >
        {attachment.name}
      </span>
      <span
        className="font-mono"
        style={{ fontSize: 10.5, color: 'var(--color-muted)' }}
      >
        {attachment.chars.toLocaleString()} chars
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          title="Remove attachment"
          style={{
            width: 20,
            height: 20,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--color-indigo)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            lineHeight: 1,
            borderRadius: 999,
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

/* ============================================================ */
/* Active state — messages list + sticky composer at bottom     */
/* ============================================================ */

function ActiveChat({
  messages,
  historyLoading,
  sending,
  onSubmit,
  onStop,
  onUpload,
  attachment,
  attaching,
  onRemoveAttachment,
  onLinkClick,
  model,
  onModelChange,
}: {
  messages: Msg[]
  historyLoading: boolean
  sending: boolean
  onSubmit: (text: string) => void
  onStop?: () => void
  onUpload?: (files: File[]) => Promise<void> | void
  model?: string | null
  onModelChange?: (next: string | null) => void
  onLinkClick?: (
    href: string,
  ) =>
    | void
    | boolean
    | {
        handled: boolean
        open: boolean
      }
    | Promise<void | boolean | { handled: boolean; open: boolean }>
} & AttachProps) {
  // Auto-scroll the messages list to bottom on new message or send.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, sending])

  return (
    <main
      className="ns-chat-surface"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        aria-busy={sending || undefined}
        className="ns-chat-scroll ns-steady-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '36px 24px 20px',
        }}
      >
        <div
          className="ns-chat-track"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          {historyLoading && messages.length === 0 ? (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--color-muted)',
                marginTop: 80,
              }}
            >
              LOADING CONVERSATION…
            </div>
          ) : (
            messages.map((m, i) => {
              const key = `${m.turn_seq ?? i}-${m.role === 'human' ? 'h' : 'a'}`
              if (m.role === 'human') {
                // Human turn — right-aligned soft card. Styling lives in
                // .ns-chat-user / .ns-chat-user-body (index.css) so General
                // and Project chat render identically.
                return (
                  <div
                    key={key}
                    role="article"
                    aria-label="Your message"
                    className="ns-chat-user"
                  >
                    <div className="ns-chat-user-inner">
                      <span aria-hidden className="ns-chat-user-rule" />
                      <div className="ns-chat-user-body">{m.content}</div>
                    </div>
                  </div>
                )
              }
              // AI turn — full-width serif body via the shared Markdown
              // component. Continuation messages (an AI bubble following
              // another AI bubble in the same turn) skip the extra top
              // margin so multi-step replies read as one block. The notesci
              // Mark signs only the conversation's last AI reply.
              const isContinuation = i > 0 && messages[i - 1].role !== 'human'
              const isLastReply =
                i === messages.length - 1 ||
                messages.slice(i + 1).every((later) => later.role !== 'ai')
              return (
                <div
                  key={key}
                  role="article"
                  aria-label="notesci reply"
                  className="ns-chat-ai"
                  style={{ marginTop: isContinuation ? 0 : 14 }}
                >
                  <div className="font-serif md-body ns-chat-ai-body">
                    <Markdown
                      text={m.content}
                      retrieved={[]}
                      onLinkClick={onLinkClick}
                    />
                  </div>
                  {isLastReply && (
                    <div aria-hidden className="ns-chat-sig">
                      <Mark size={16} />
                    </div>
                  )}
                </div>
              )
            })
          )}
          {sending && <ThinkingIndicator />}
        </div>
      </div>

      <div className="ns-composer-dock">
        <div className="ns-chat-track">
          {attachment && (
            <AttachmentChip
              attachment={attachment}
              onRemove={onRemoveAttachment}
            />
          )}
          <Composer
            onSubmit={onSubmit}
            onStop={onStop}
            onUpload={onUpload}
            sending={sending}
            attaching={attaching}
            model={model}
            onModelChange={onModelChange}
            placeholder="Continue the conversation…"
          />
        </div>
      </div>
    </main>
  )
}

function ThinkingIndicator() {
  return (
    <div
      aria-live="polite"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        color: 'var(--color-muted)',
        fontSize: 12.5,
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          background: 'var(--color-indigo-soft)',
          color: 'var(--color-indigo)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icons.bot size={13} />
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: 'var(--color-indigo)',
              animation: 'pulse-dot 1.2s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
            }}
          />
        ))}
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          letterSpacing: '0.06em',
        }}
      >
        THINKING…
      </span>
    </div>
  )
}

/* ============================================================ */
/* Composer                                                     */
/* ============================================================ */

function Composer({
  onSubmit,
  onStop,
  onUpload,
  sending,
  attaching: externalAttaching,
  model,
  onModelChange,
  placeholder = 'Ask anything.',
}: {
  onSubmit: (text: string) => void
  onStop?: () => void
  /** Optional file-attach callback. When provided, the composer renders
   *  a paperclip button that opens a file picker — on pick, the parent
   *  decides what to do with the file. In general chat, the parent
   *  extracts PDF text client-side and queues it as a per-turn
   *  attachment (no project created). */
  onUpload?: (files: File[]) => Promise<void> | void
  sending: boolean
  /** When the parent is mid-extract (PDF reading), reflect that in
   *  the paperclip's busy state. Internal local `uploading` covers
   *  the brief window between click and the parent callback resolving;
   *  the external flag covers longer parent-side work. */
  attaching?: boolean
  /** Selected model ("<provider>:<model_id>" or null = server default)
   *  and its setter. The ModelPill self-hides when ≤1 model is
   *  available, so on a single-provider setup nothing renders. */
  model?: string | null
  onModelChange?: (next: string | null) => void
  placeholder?: string
}) {
  const [text, setText] = useState('')
  const [uploadingLocal, setUploadingLocal] = useState(false)
  const uploading = uploadingLocal || externalAttaching === true
  const taId = useId()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`
  }, [text])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    onSubmit(trimmed)
    setText('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition guard — Enter during CJK composition must
    // never trigger send (it's confirming a candidate). Required
    // for every Enter-driven input across the app.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    // Standard chat UX: Enter sends, Shift+Enter inserts a
    // newline. Diverges intentionally from Project chat's
    // Cmd+Enter gate per user expectation — `notesci` chat now
    // matches ChatGPT / Claude.ai composer behavior on this surface.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const canSend = text.trim().length > 0

  return (
    <div
      className="ns-composer-shell"
      style={{ maxWidth: '100%', opacity: sending ? 0.96 : 1 }}
    >
      <label htmlFor={taId} style={{ position: 'absolute', left: -9999 }}>
        Ask anything
      </label>
      <textarea
        id={taId}
        ref={taRef}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={sending}
        placeholder={placeholder}
        style={{
          resize: 'none',
          width: '100%',
          border: 'none',
          outline: 'none',
          // Generous vertical breathing room + a small horizontal
          // indent so the cursor doesn't kiss the shell's edge. The
          // typography matches the UserBubble exactly so the composer
          // reads as "what you're about to send" — same serif, same
          // italic, same size — and the conversation has a single
          // typographic voice from input to outgoing message.
          padding: '8px 4px 4px',
          font: 'inherit',
          fontFamily: 'var(--font-serif), Georgia, serif',
          fontSize: 18,
          fontStyle: 'italic',
          fontWeight: 500,
          lineHeight: 1.45,
          letterSpacing: '-0.005em',
          color: 'var(--color-ink)',
          background: 'transparent',
          display: 'block',
          minHeight: 60,
          maxHeight: 240,
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length === 0 || !onUpload) return
          setUploadingLocal(true)
          try {
            await onUpload(files)
          } finally {
            setUploadingLocal(false)
          }
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {onUpload && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || sending}
            aria-busy={uploading || undefined}
            aria-label="Attach a PDF"
            title="Attach a PDF to this message"
            style={{
              width: 30,
              height: 30,
              padding: 0,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              color: uploading
                ? 'var(--color-muted)'
                : 'var(--color-ink-2)',
              border: '1px solid var(--color-rule)',
              cursor: uploading || sending ? 'not-allowed' : 'pointer',
              transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
            }}
            onMouseEnter={(e) => {
              if (uploading || sending) return
              e.currentTarget.style.color = 'var(--color-indigo)'
              e.currentTarget.style.borderColor = 'var(--color-indigo)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = uploading
                ? 'var(--color-muted)'
                : 'var(--color-ink-2)'
              e.currentTarget.style.borderColor = 'var(--color-rule)'
            }}
          >
            {uploading ? (
              <span className="spinner" aria-hidden />
            ) : (
              <Icons.attach size={13} />
            )}
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {onModelChange && (
            <ModelPill value={model ?? null} onChange={onModelChange} />
          )}
          <span
            className="font-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--color-muted)',
              letterSpacing: '0.04em',
            }}
          >
            ↩
          </span>
          <button
            type="button"
            onClick={() => {
              if (sending) onStop?.()
              else submit()
            }}
            disabled={!sending && !canSend}
            aria-label={sending ? 'Stop generating' : 'Send message'}
            title={sending ? 'Stop generating' : 'Send (Enter)'}
            style={{
              width: 34,
              height: 34,
              padding: 0,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: sending
                ? 'var(--color-error)'
                : canSend
                  ? 'var(--color-indigo)'
                  : 'var(--color-paper-2)',
              color: sending || canSend ? '#fff' : 'var(--color-muted)',
              border: `1px solid ${sending ? 'var(--color-error)' : canSend ? 'var(--color-indigo)' : 'var(--color-rule)'}`,
              cursor: sending || canSend ? 'pointer' : 'not-allowed',
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            {sending ? (
              <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>■</span>
            ) : (
              <Icons.send size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================ */
/* Project menu                                                 */
/* ============================================================ */

function ProjectMenu({
  projects,
  onPick,
  onClose,
}: {
  projects: ProjectOut[]
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <div
      role="menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      style={{
        position: 'absolute',
        top: 38,
        right: 44,
        minWidth: 240,
        maxHeight: 360,
        overflowY: 'auto',
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 10,
        boxShadow: '0 8px 28px -8px rgba(14,17,22,.18), 0 2px 6px -2px rgba(14,17,22,.08)',
        padding: 6,
        zIndex: 20,
      }}
    >
      <div
        style={{
          padding: '6px 10px 8px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          letterSpacing: '0.08em',
          color: 'var(--color-muted)',
        }}
      >
        YOUR PROJECTS
      </div>
      {projects.length === 0 ? (
        <div style={{ padding: '8px 10px', fontSize: 13, color: 'var(--color-muted)' }}>
          No projects yet.
        </div>
      ) : (
        projects.map((p) => (
          <button
            key={p.id}
            type="button"
            role="menuitem"
            onClick={() => onPick(p.id)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              border: 'none',
              background: 'transparent',
              fontSize: 13,
              color: 'var(--color-ink)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-paper-2)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
          >
            {p.name}
          </button>
        ))
      )}
    </div>
  )
}

/* ============================================================ */
/* Avatar dropdown                                              */
/* ============================================================ */

function AvatarMenu({
  me,
  onClose,
}: {
  me: MeOut | null
  onClose: () => void
}) {
  return (
    <div
      role="menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      style={{
        position: 'absolute',
        top: 38,
        right: 0,
        minWidth: 200,
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 10,
        boxShadow: '0 8px 28px -8px rgba(14,17,22,.18), 0 2px 6px -2px rgba(14,17,22,.08)',
        padding: 6,
        zIndex: 20,
      }}
    >
      {me && (
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--color-rule)',
            marginBottom: 4,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-ink)' }}>
            {me.display_name || 'Account'}
          </div>
        </div>
      )}
      <Link
        to="/settings/preferences"
        role="menuitem"
        onClick={onClose}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          fontSize: 13,
          color: 'var(--color-ink)',
          textDecoration: 'none',
          borderRadius: 6,
        }}
      >
        Settings
      </Link>
      <Link
        to="/library"
        role="menuitem"
        onClick={onClose}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          fontSize: 13,
          color: 'var(--color-ink)',
          textDecoration: 'none',
          borderRadius: 6,
        }}
      >
        Library
      </Link>
    </div>
  )
}
