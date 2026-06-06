import { useEffect, useId, useRef, useState } from 'react'
import { Icons } from '../icons'
import { Mark } from '../brand/Mark'
import {
  api,
  apiSse,
  apiForm,
  NETWORK_ERROR_MESSAGE,
  type ApiError,
} from '../../lib/api'
import { patchPrefs, readPrefs } from '../../lib/prefs'
import {
  getProviders,
  resolveActiveModel,
  resolveUploadModel,
} from '../../lib/models'
import { Markdown, type CitationClick } from '../../lib/markdown'
import { handleMcpLinkInstall } from '../../lib/mcpLinks'
import { useToast } from '../Toast'
import { ModelPill } from './ModelPill'
import { SlashMirror, detectSlashMode } from './SlashMode'

export interface ChatMessage {
  role: 'human' | 'ai' | 'tool' | 'system'
  content: string
  /** Citation refs returned alongside the response. */
  retrieved?: {
    chunk_id: number
    material_id: string
    title: string | null
    distance: number
    material_url: string | null
    marker_n?: number | null
    source_kind?: 'internal' | 'external' | null
  }[]
  /** Names of proprietary skills the backend's intent router activated
   *  for this turn. Surfaced as a subtle on-bubble badge so users see
   *  *that* a domain mode kicked in without exposing the implementation
   *  details (the skill briefs themselves stay server-side). */
  skills?: string[]
  /** Canonical "<provider>:<model_id>" the backend reported for this
   *  AI bubble. Surfaced as a small subscript so users can see which
   *  model handled which turn — important when switching mid-thread. */
  model_used?: string | null
  /** How many long-term memories the hybrid recall pulled before this
   *  reply. Surfaced as a "Recalled N notes" chip so users can see when
   *  saved memory shaped the answer. */
  memory_recalled_count?: number
  /** Recalled memory details returned for the live response. Historical
   *  bubbles may only have the count until recall metadata is persisted. */
  memory_recalled?: {
    id: string
    scope: 'general' | 'project'
    project_id: string | null
    kind: string
    title: string
    body: string
    source_session?: string | null
  }[]
}

/** Map backend skill ids to short user-facing labels. The implementation
 *  details (regex patterns, briefs) stay hidden — users only see a
 *  natural-sounding tag on the AI bubble. */
const SKILL_LABELS: Record<string, string> = {
  'content-research-writer': 'Scientific drafting',
  'scientific-slides': 'Slide design',
  'writing-clearly-and-concisely': 'Manuscript polish',
}

const EMPTY_ASSISTANT_REPLY =
  'The model request completed, but no visible text came back. Try again, or switch models.'
const INTERRUPTED_ASSISTANT_REPLY =
  '\n\n[Stream interrupted before the final response finished.]'

/** Shared between the real <textarea> and the SlashMirror overlay so
 *  the highlighted tokens line up under the textarea's caret. Any
 *  change to font / line-height / padding must be applied to BOTH. */
const CHAT_TEXTAREA_STYLE: React.CSSProperties = {
  resize: 'none',
  border: 'none',
  outline: 'none',
  font: 'inherit',
  fontSize: 18,
  lineHeight: 1.45,
  fontFamily: 'var(--font-serif), Georgia, serif',
  fontStyle: 'italic',
  fontWeight: 500,
  letterSpacing: '-0.005em',
  width: '100%',
  minHeight: 60,
  maxHeight: 240,
  overflowY: 'auto',
  padding: '8px 4px 4px',
  margin: 0,
  background: 'transparent',
}

export interface SlashCommand {
  label: string
  hint: string
  insert: string
}

/** Build the slash-command menu for the chat composer. Prompts adapt
 *  to the number of materials in scope so they read naturally for a
 *  single-source project, a multi-source project, or an empty one.
 *  Exported so the empty-state hero composer can show the same hints. */
export function buildSlashCommands(
  materials: readonly { title: string | null }[] = [],
): SlashCommand[] {
  const n = materials.length
  const firstTitle = materials[0]?.title ?? 'this source'
  const secondTitle = materials[1]?.title ?? 'the second source'
  return [
    {
      label: '/summarize',
      hint:
        n <= 1
          ? `One-paragraph summary of ${firstTitle}.`
          : `Group ${n} sources by theme with one paragraph each.`,
      insert:
        n <= 1
          ? `Summarize ${firstTitle} in one paragraph.`
          : `Summarize all ${n} sources, grouped by theme.`,
    },
    {
      label: '/compare',
      hint:
        n >= 2
          ? `${firstTitle} vs. ${secondTitle}.`
          : 'What would push back on the central claim?',
      insert:
        n >= 2
          ? `Compare ${firstTitle} and ${secondTitle}: claims, methods, and where they disagree.`
          : "What's the central claim of this paper, and what would push back on it?",
    },
    {
      label: '/discover',
      hint: "Surface sources you haven't asked about.",
      insert: "Find sources I haven't asked about and tell me what's notable.",
    },
    {
      label: '/draft',
      hint:
        n >= 5
          ? `Draft a literature review from all ${n} sources.`
          : 'Draft a literature review from these sources.',
      insert:
        n >= 5
          ? `Draft a literature review from all ${n} sources, with citations.`
          : `Draft a literature review from ${n === 1 ? 'this source' : `these ${n} sources`}, with citations.`,
    },
  ]
}

/** Lightweight client-side check that the input parses as an http(s)
 *  URL. The backend does the real allowlisting; this just gates the
 *  Add button so users don't see a server error for `asdf`. */
export function isLikelyHttpUrl(s: string): boolean {
  const v = s.trim()
  if (!v) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Trigger a Markdown download of a single draft preview (the user
 *  clicked Export on the chat-side draft popup). Project name is
 *  embedded for context in the saved filename and frontmatter. */
function exportDraftAsMarkdown(
  content: string,
  projectName: string,
  toast: ReturnType<typeof useToast>,
) {
  if (!content.trim()) {
    toast.warn('Nothing to export.')
    return
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const lines = [
    `# Draft — ${projectName}`,
    '',
    `*Exported ${new Date().toLocaleString()}*`,
    '',
    content,
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `notesci-draft-${stamp}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  toast.success('Draft exported as Markdown.')
}

/**
 * Center chat pane. Messages with citation chips (parses [N] markers)
 * · composer with /draft, @source, model pill. Enter sends;
 * Shift+Enter inserts a newline. Per-message timestamps land when the
 * backend starts returning created_at on the chat-history endpoint.
 *
 * Wired to the backend's POST /chat. Replies are returned in full —
 * SSE streaming via /chat/stream is a planned enhancement, not yet
 * wired here.
 */
export function ChatPane({
  threadId,
  projectId,
  projectName,
  initialMessages = [],
  initialDraft,
  initialAutoSend = false,
  materials = [],
  onThreadResolved,
  onOpenReader,
  onJumpToCitation,
  onOpenExternalSource,
  onSendToDraft,
  onMaterialIngested,
  onIngestionStarted,
  onUploadAttempt,
}: {
  threadId: string | null
  projectId: string | null
  projectName: string
  initialMessages?: ChatMessage[]
  /** Optional pre-filled composer text — used by empty-session starter chips. */
  initialDraft?: string
  /** When true AND `initialDraft` is non-empty on mount, auto-fire
   *  `submit()` once the composer is settled. The hero composer sets
   *  this so pressing Enter / Send there actually sends the prompt
   *  to the model instead of just staging it into this pane. */
  initialAutoSend?: boolean
  /** Fired around every /materials/ingest-pdf round-trip so the host
   *  can track "uploads still in flight" — with `+1` before the API
   *  call, `-1` in the finally clause. The host gates its upload
   *  view's Continue button on this reaching zero so a fast first
   *  file can't make the view look "done" while later files are
   *  still uploading. */
  onUploadAttempt?: (delta: 1 | -1) => void
  /** Project materials, used by the `@source` mention picker. */
  materials?: { id: string; title: string | null; source_type: string }[]
  onThreadResolved?: (id: string) => void
  /** Called with a material_id when the user clicks "Open reader" (the
   *  per-message footer link). */
  onOpenReader?: (materialId: string | null) => void
  /** Called when the user clicks a citation chip ``[N]`` inside an
   *  assistant bubble. Receives the material + chunk so the host can
   *  open the reader AND scroll to the cited passage. */
  onJumpToCitation?: (detail: CitationClick) => void
  /** Called when an assistant reply includes an ordinary external source link. */
  onOpenExternalSource?: (url: string) => void
  /** Called with text the user wants appended to the active draft. */
  onSendToDraft?: (text: string) => void
  /** Called after a successful PDF ingest so the host can refresh the materials list. */
  onMaterialIngested?: () => void
  /** Called when a new ingestion job starts so the host can render
   *  progress UI for the background pipeline (rename + concepts + wiki
   *  links). */
  onIngestionStarted?: (input: {
    materialId: string
    jobId: string | null
    label: string
  }) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [input, setInput] = useState(initialDraft ?? '')
  const [sending, setSending] = useState(false)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [urlPromptOpen, setUrlPromptOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashCursor, setSlashCursor] = useState(0)
  /** When the user picks "Save as draft" on an AI message (or the
   *  workflow finishes), we slide a preview card in on the LEFT of
   *  the conversation. The user can save it into the project's Draft
   *  library, export it, or dismiss. Null = no preview open. */
  const [pendingDraft, setPendingDraft] = useState<string | null>(null)
  // Read the default agent style from PreferencesPage (localStorage). The
  // composer pill cycles through it; saving back into the same prefs blob.
  // Per-composer model selection. Initialised from the user's saved
  // pref (canonical "<provider>:<model_id>" or null = "server default")
  // and persisted back as soon as the user picks something else from
  // the in-chat ModelPill — Preferences and the pill stay in sync.
  const [selectedModel, setSelectedModel] = useState<string | null>(
    () => readPrefs().defaultModel,
  )
  // Retrieval mode for this composer. Persisted in the same prefs blob
  // so the choice survives reloads and stays in sync across tabs.
  const [retrievalMode, setRetrievalMode] = useState<'vector' | 'tree'>(
    () => readPrefs().retrievalMode,
  )
  // One-shot guard so the "no trees ready, falling back to vector"
  // toast only fires once per session — repeated turns shouldn't keep
  // re-toasting the same message.
  const [fallbackHinted, setFallbackHinted] = useState(false)
  // Incognito: per-turn opt-out of memory READ + WRITE for this message.
  // Not persisted — the toggle returns to default after each send so a
  // private question doesn't quietly disable memory for the next one.
  const [memoryIncognito, setMemoryIncognito] = useState(false)
  useEffect(() => {
    const onPrefsChanged = () => {
      const p = readPrefs()
      setSelectedModel(p.defaultModel)
      setRetrievalMode(p.retrievalMode)
    }
    window.addEventListener('notesci-prefs-changed', onPrefsChanged)
    return () => window.removeEventListener('notesci-prefs-changed', onPrefsChanged)
  }, [])
  const updateSelectedModel = (next: string | null) => {
    setSelectedModel(next)
    patchPrefs('defaultModel', next)
  }
  const toggleRetrievalMode = () => {
    const next = retrievalMode === 'vector' ? 'tree' : 'vector'
    setRetrievalMode(next)
    patchPrefs('retrievalMode', next)
  }
  // Warm the catalog cache on mount so historical bubbles' model labels
  // and the in-chat ModelPill render with friendly names on first paint.
  useEffect(() => {
    void getProviders().catch(() => {
      /* offline / 401 — pill falls back to "default", bubbles to raw ids */
    })
  }, [])
  const resolveModelForRequest = async (): Promise<string | null> => {
    const preferred = selectedModel
    const catalog = await getProviders().catch(() => null)
    if (catalog) return resolveActiveModel(preferred, catalog)
    return resolveActiveModel(preferred, null)
  }
  const resolveUploadModelForRequest = async (): Promise<string | null> => {
    const preferred = selectedModel
    const catalog = await getProviders().catch(() => null)
    return resolveUploadModel(preferred, catalog)
  }
  const attachWrapRef = useRef<HTMLDivElement | null>(null)
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sourcePickerWrapRef = useRef<HTMLDivElement | null>(null)
  const sourcePickerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const commandMenuWrapRef = useRef<HTMLDivElement | null>(null)
  const commandMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Close popovers on outside click or Esc.
  useEffect(() => {
    if (!attachOpen && !sourcePickerOpen && !commandMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (
        attachOpen &&
        attachWrapRef.current &&
        !attachWrapRef.current.contains(e.target as Node)
      ) {
        setAttachOpen(false)
      }
      if (
        sourcePickerOpen &&
        sourcePickerWrapRef.current &&
        !sourcePickerWrapRef.current.contains(e.target as Node)
      ) {
        setSourcePickerOpen(false)
      }
      if (
        commandMenuOpen &&
        commandMenuWrapRef.current &&
        !commandMenuWrapRef.current.contains(e.target as Node)
      ) {
        setCommandMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Refocus the trigger so keyboard users keep their place after
      // the popover closes.
      if (attachOpen) {
        setAttachOpen(false)
        attachTriggerRef.current?.focus()
      }
      if (sourcePickerOpen) {
        setSourcePickerOpen(false)
        sourcePickerTriggerRef.current?.focus()
      }
      if (commandMenuOpen) {
        setCommandMenuOpen(false)
        commandMenuTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [attachOpen, sourcePickerOpen, commandMenuOpen])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const attachMenuId = useId()
  const sourcePickerId = useId()
  const commandMenuId = useId()
  // Keep the textarea sized to its content when input is set imperatively
  // (starter prefill, error rollback, slash-pick replacement).
  useEffect(() => {
    const ta = composerRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(240, ta.scrollHeight)}px`
  }, [input])

  // Adopt a new pre-fill from the host (e.g., starter-chip click).
  // Place the cursor at the end so the user can keep typing without
  // first pressing End.
  useEffect(() => {
    if (initialDraft !== undefined) {
      setInput(initialDraft)
      const ta = composerRef.current
      if (ta) {
        ta.focus()
        const end = initialDraft.length
        // Defer to next paint so the new value is in the DOM before
        // we move the caret.
        requestAnimationFrame(() => {
          ta.selectionStart = end
          ta.selectionEnd = end
        })
      }
    }
  }, [initialDraft])

  const onLinkClick = (href: string) => {
    if (/^https?:\/\//i.test(href) && onOpenExternalSource) {
      onOpenExternalSource(href)
      return true
    }
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
      return result.handled ? !result.open : false
    })
  }

  // Auto-send on mount when the host signalled `initialAutoSend`. This
  // covers the hero composer's Enter / Send: the user typed in the
  // empty-state composer, pressed Enter, and reasonably expects the
  // message to go to the model — without this they'd be dropped into
  // ChatPane with the text staged in the textarea and have to press
  // Send a second time. We use a ref-guard so the auto-send fires
  // exactly once even though the effect re-runs every time
  // `initialDraft` changes (e.g. a follow-up starter chip click during
  // the same session). `submit()` itself guards on `!text || sending`,
  // so an empty `initialDraft` with `autoSend` is a no-op.
  const autoSentRef = useRef(false)
  useEffect(() => {
    if (!initialAutoSend) return
    if (autoSentRef.current) return
    if (!initialDraft || !initialDraft.trim()) return
    autoSentRef.current = true
    // NOTE: no cleanup that cancels this rAF. React strict mode
    // double-invokes effects in dev (setup → cleanup → setup), and a
    // cancelAnimationFrame in cleanup would cancel the very rAF we
    // just scheduled — the second setup then skips (`autoSentRef`
    // already true) and the message never actually gets sent. The
    // `autoSentRef` gate guarantees submit() runs at most once per
    // mount even with the double-invoke. submit() itself guards on
    // `!text || sending`, so a stale fire after an in-progress send
    // is a no-op.
    requestAnimationFrame(() => {
      void submit()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAutoSend, initialDraft])

  // Load existing thread when threadId changes.
  useEffect(() => {
    setError(null)
    if (sending) return
    if (!threadId) {
      setMessages([])
      return
    }
    void (async () => {
      try {
        const res = await api<{
          thread_id: string
          messages: {
            role: string
            content: string
            model_used?: string | null
            retrieved?: ChatMessage['retrieved']
          }[]
        }>(`/threads/${threadId}/messages`, { auth: true })
        setMessages(
          res.messages.map((m) => ({
            role: (m.role as ChatMessage['role']) ?? 'system',
            content: m.content,
            model_used: m.model_used ?? null,
            retrieved: m.retrieved,
          })),
        )
      } catch {
        // 404 if a brand-new local thread; fine.
      }
    })()
  }, [threadId, sending])

  // Scroll to bottom on new messages — but only if the user is already
  // near the bottom. If they've scrolled up to read older messages,
  // don't yank the viewport away from where they're reading.
  const nearBottomRef = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (!nearBottomRef.current) return
    const frame = window.requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight })
    })
    return () => window.cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sending])
  // Track scroll position for the auto-scroll gate + the "jump to latest"
  // affordance.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => {
      const threshold = 80
      const next = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
      nearBottomRef.current = next
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  const submit = async () => {
    const text = input.trim()
    if (!text || sending) return
    setError(null)
    setMessages((m) => [...m, { role: 'human', content: text }])
    setInput('')
    setSending(true)
    const ac = new AbortController()
    abortRef.current = ac
    let aiStarted = false
    let reply = ''
    let flushFrame: number | null = null
    try {
      const modelToSend = await resolveModelForRequest()
      let streamedThreadId: string | null = null
      let pendingRetrieved: ChatMessage['retrieved'] | undefined
      const flushReply = () => {
        flushFrame = null
        if (!aiStarted) {
          aiStarted = true
          setMessages((m) => [...m, { role: 'ai', content: reply, retrieved: pendingRetrieved }])
        } else {
          setMessages((m) =>
            m.map((msg, i) =>
              i === m.length - 1 && msg.role === 'ai'
                ? { ...msg, content: reply }
                : msg,
            ),
          )
        }
      }
      const scheduleFlush = () => {
        if (flushFrame != null) return
        flushFrame = window.requestAnimationFrame(flushReply)
      }
      await apiSse('/chat/stream', {
        method: 'POST',
        auth: true,
        body: JSON.stringify({
          message: text,
          thread_id: threadId,
          project_id: threadId ? null : projectId,
          // Effective model: the user's pick *if it's still in the
          // catalog*; null defers to the server default. Stale picks
          // (model retired after the pref was stored) silently fall
          // back instead of erroring at the provider.
          model: modelToSend,
          // 'tree' silently falls back to 'vector' server-side if no
          // material trees are ready for this project — safe to send
          // unconditionally.
          retrieval_mode: retrievalMode,
          memory_incognito: memoryIncognito,
        }),
        signal: ac.signal,
      }, (event) => {
        if (event.type === 'session' && typeof event.thread_id === 'string') {
          streamedThreadId = event.thread_id
          if (!threadId) onThreadResolved?.(event.thread_id)
          return
        }
        if (event.type === 'token' && typeof event.text === 'string') {
          reply += event.text
          scheduleFlush()
          return
        }
        if (event.type === 'retrieved') {
          const retrieved = (event.chunks ?? []) as ChatMessage['retrieved']
          pendingRetrieved = retrieved
          setMessages((m) =>
            m.length > 0 && m[m.length - 1].role === 'ai'
              ? m.map((msg, i) =>
                  i === m.length - 1 ? { ...msg, retrieved } : msg,
                )
              : [...m, { role: 'ai', content: reply, retrieved }],
          )
          aiStarted = true
          return
        }
        if (event.type === 'skills') {
          const skills = Array.isArray(event.skills) ? event.skills as string[] : []
          setMessages((m) =>
            m.map((msg, i) =>
              i === m.length - 1 && msg.role === 'ai'
                ? { ...msg, skills }
                : msg,
            ),
          )
          return
        }
        if (event.type === 'memory') {
          setMessages((m) =>
            m.map((msg, i) =>
              i === m.length - 1 && msg.role === 'ai'
                ? {
                    ...msg,
                    memory_recalled_count:
                      typeof event.memory_recalled_count === 'number'
                        ? event.memory_recalled_count
                        : 0,
                    memory_recalled: Array.isArray(event.memory_recalled)
                      ? event.memory_recalled as ChatMessage['memory_recalled']
                      : [],
                  }
                : msg,
            ),
          )
          return
        }
        if (event.type === 'done') {
          if (typeof event.final_text === 'string' && event.final_text) {
            reply = event.final_text
          }
          if (!reply.trim()) reply = EMPTY_ASSISTANT_REPLY
          if (flushFrame != null) {
            window.cancelAnimationFrame(flushFrame)
            flushReply()
          } else if (!aiStarted && reply) {
            flushReply()
          }
          if (
            retrievalMode === 'tree' &&
            event.retrieval_mode_used === 'vector' &&
            !fallbackHinted
          ) {
            toast.toast(
              'No PageIndex trees ready for this project yet — answering with vector retrieval. The reasoning mode will activate once a PDF tree-build finishes.',
            )
            setFallbackHinted(true)
          }
          setMessages((m) =>
            m.length > 0 && m[m.length - 1].role === 'ai'
              ? m.map((msg, i) =>
                  i === m.length - 1
                    ? {
                        ...msg,
                        content: reply || msg.content,
                        retrieved: msg.retrieved ?? pendingRetrieved,
                        model_used:
                          typeof event.model_used === 'string'
                            ? event.model_used
                            : null,
                      }
                    : msg,
                )
              : [
                  ...m,
                  {
                    role: 'ai',
                    content: reply,
                    retrieved: pendingRetrieved,
                    model_used:
                      typeof event.model_used === 'string'
                        ? event.model_used
                        : null,
                  },
                ],
          )
        }
      })
      if (!threadId && streamedThreadId) onThreadResolved?.(streamedThreadId)
    } catch (err) {
      const e = err as ApiError
      if (e.code === 'aborted' || e.name === 'AbortError') {
        setError(null)
        return
      }
      const msg =
        e.status === 0 || e.code === 'network_error'
          ? NETWORK_ERROR_MESSAGE
          : e.status === 429 || e.code === 'rate_limited'
            ? // Backend already crafts a useful message that includes a
              // retry-in hint when the provider sent one. Surface it
              // verbatim; fall back to a generic line if missing.
              (e.message ??
                'Rate limit hit on the model provider. Wait a moment and retry, or switch to a different model in the chat picker.')
            : e.status === 502
              ? 'The agent failed mid-turn. Check the backend logs or switch model and retry.'
              : e.status === 504
              ? 'The agent took too long to reply. Try a shorter prompt or simpler question.'
              : `Chat failed (${e.status}${e.code ? ' · ' + e.code : ''}).`
      setError(msg)
      if (flushFrame != null) {
        window.cancelAnimationFrame(flushFrame)
        flushFrame = null
      }
      if (aiStarted || reply.trim()) {
        const content = reply.trim()
          ? `${reply}${INTERRUPTED_ASSISTANT_REPLY}`
          : EMPTY_ASSISTANT_REPLY
        setMessages((m) =>
          m.length > 0 && m[m.length - 1].role === 'ai'
            ? m.map((message, i) =>
                i === m.length - 1 ? { ...message, content } : message,
              )
            : [...m, { role: 'ai', content }],
        )
        return
      }
      // Roll back the optimistic user message AND restore the input so
      // the user doesn't have to retype after a network blip.
      setMessages((m) => m.slice(0, -1))
      setInput(text)
    } finally {
      if (abortRef.current === ac) abortRef.current = null
      setSending(false)
      composerRef.current?.focus()
      // Incognito is one-shot — clear so the next turn returns to default.
      setMemoryIncognito(false)
    }
  }

  // Slash commands. Selecting one inserts only the command token, then
  // leaves the rest of the composer for the user's own prompt.
  const SLASH_COMMANDS = buildSlashCommands(materials)

  const slashFilter = (() => {
    if (!slashOpen) return ''
    const m = input.match(/(?:^|\n)\/([\w-]*)$/)
    return m ? m[1].toLowerCase() : ''
  })()
  const filteredSlash = SLASH_COMMANDS.filter((c) =>
    c.label.slice(1).toLowerCase().includes(slashFilter),
  )
  // Slash-mode chip: shown above the composer when the user's input
  // starts with a known slash command (e.g. typed "/draft"). Drives
  // the indigo border + box-shadow on the composer shell so the mode
  // shift reads visually, not just as a tooltip.
  const slashMode = detectSlashMode(input, SLASH_COMMANDS)

  const pickSlash = (cmd: (typeof SLASH_COMMANDS)[number]) => {
    setSlashOpen(false)
    setInput((cur) => {
      const prefix = cur.replace(/(?:^|\n)\/[\w-]*$/, '')
      const needsSpace = prefix.length > 0 && !/\s$/.test(prefix)
      return `${prefix}${needsSpace ? ' ' : ''}${cmd.label} `
    })
    requestAnimationFrame(() => {
      const ta = composerRef.current
      if (!ta) return
      ta.focus()
      const end = ta.value.length
      ta.selectionStart = end
      ta.selectionEnd = end
    })
  }

  const submitUrl = async () => {
    const url = urlValue.trim()
    if (!url || !projectId) return
    setUploading(true)
    const modelToSend = await resolveUploadModelForRequest()
    onUploadAttempt?.(1)
    try {
      const ok = await api<{ material_id: string; job_id?: string | null }>(
        '/materials/ingest-url',
        {
          method: 'POST',
          auth: true,
          body: JSON.stringify({
            project_id: projectId,
            url,
            model: modelToSend,
          }),
        },
      )
      setError(null)
      setUrlPromptOpen(false)
      setUrlValue('')
      onMaterialIngested?.()
      if (ok?.material_id) {
        onIngestionStarted?.({
          materialId: ok.material_id,
          jobId: ok.job_id ?? null,
          label: url,
        })
      }
      // Send focus back to the composer so the user can keep typing.
      composerRef.current?.focus()
    } catch (err) {
      const e = err as ApiError
      setError(
        e.code === 'embedding_provider_unavailable'
          ? "Source indexing needs an embedding provider — add OpenAI, Google, or a custom embedding endpoint in Settings."
          : e.code === 'url_not_allowed'
            ? "That URL isn't allowed (loopback / private hosts blocked)."
            : e.code === 'url_fetch_failed'
              ? "We couldn't fetch that URL."
              : e.code === 'empty_url_content'
                ? "We couldn't extract any text from that page."
                : `URL ingest failed (${e.status}${e.code ? ' · ' + e.code : ''}).`,
      )
    } finally {
      setUploading(false)
      onUploadAttempt?.(-1)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME guard — ignore keystrokes while an input-method composition
    // is active. A CJK user typing Chinese/Japanese/Korean presses
    // Enter to *confirm a candidate character*; without this guard
    // that Enter would fire submit() and abort their input, so they
    // could never get composed text into the box. `isComposing` is on
    // the native event; keyCode 229 is the legacy "composing" signal
    // for older Safari.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (slashOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashCursor((c) => Math.min(filteredSlash.length - 1, c + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashCursor((c) => Math.max(0, c - 1))
        return
      }
      // While the slash menu is open, plain Enter picks the highlighted
      // command instead of sending. Shift+Enter falls through to the
      // newline behaviour below.
      if (e.key === 'Enter' && !e.shiftKey) {
        const cmd = filteredSlash[slashCursor]
        if (cmd) {
          e.preventDefault()
          pickSlash(cmd)
          return
        }
      }
    }
    // Enter sends; Shift+Enter inserts a newline (the textarea's default
    // behaviour, so we just don't preventDefault for it). ⌘/Ctrl+Enter
    // is kept as a send alias for existing muscle memory.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void submit()
    }
  }

  const onComposerChange = (next: string) => {
    setInput(next)
    // Open the slash menu when the user is typing a "/<word>" at the
    // start of the textarea or after a newline. Close it as soon as the
    // pattern no longer holds (e.g. they typed a space).
    const open = /(?:^|\n)\/([\w-]*)$/.test(next)
    if (open !== slashOpen) {
      setSlashOpen(open)
      setSlashCursor(0)
    }
  }

  return (
    <section
      aria-label="Chat"
      className="pane ns-chat-surface"
      style={{ height: '100%' }}
    >
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {pendingDraft != null && (
        <DraftPreview
          content={pendingDraft}
          onSave={() => {
            if (onSendToDraft) onSendToDraft(pendingDraft)
            setPendingDraft(null)
            toast.success('Saved to Draft.')
          }}
          onExport={() => {
            exportDraftAsMarkdown(pendingDraft, projectName, toast)
          }}
          onDismiss={() => setPendingDraft(null)}
        />
      )}
      <div
        ref={bodyRef}
        className="pane-body ns-chat-scroll ns-steady-scroll"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        aria-busy={sending || undefined}
        style={{
          padding: '22px 22px 26px',
          display: 'flex',
          flexDirection: 'column',
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
          {messages.map((m, i) => (
            <MessageRow
              key={i}
              m={m}
              isLastReply={isLastReply(messages, i)}
              isContinuation={i > 0 && messages[i - 1].role !== 'human'}
              onOpenReader={onOpenReader}
              onJumpToCitation={onJumpToCitation}
              onOpenExternalSource={onOpenExternalSource}
              onSendToDraft={onSendToDraft ? (text) => setPendingDraft(text) : undefined}
              onLinkClick={onLinkClick}
            />
          ))}
          {sending &&
            (messages.length === 0 ||
              messages[messages.length - 1].role !== 'ai' ||
              !messages[messages.length - 1].content.trim()) && (
            <div
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
              className="font-mono"
              style={{ fontSize: 10.5, letterSpacing: '0.06em' }}
            >
              THINKING…
            </span>
            </div>
          )}
          {error && (
            <div
              role="alert"
              style={{
                fontSize: 12.5,
                padding: '8px 12px',
                border: '1px solid var(--color-error)',
                borderRadius: 8,
                color: 'var(--color-error)',
                background:
                  'color-mix(in oklch, var(--color-error) 8%, transparent)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
            <span style={{ flex: 1 }}>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-error)',
                cursor: 'pointer',
                fontSize: 13,
                padding: 2,
                lineHeight: 1,
              }}
            >
              <span aria-hidden>✕</span>
            </button>
            </div>
          )}
          </div>
      </div>
      </div>

      <div style={{ position: 'relative' }}>
      <div className="ns-composer-dock">
        {/* Glass composer — base look (translucent fill, blur, lit edge,
            layered shadow), focus halo, and slash-mode tint all live in
            `.ns-composer-shell` CSS. `data-slash` drives the indigo
            variant; width/centering match the conversation column. */}
        <div
          className="ns-composer-shell"
          data-slash={slashMode ? 'true' : undefined}
        >
          <div style={{ position: 'relative' }}>
            {(slashOpen || slashMode) && (
              <SlashMirror
                value={input}
                placeholder="Ask anything about your sources, or type / for commands…"
                commands={SLASH_COMMANDS}
                style={CHAT_TEXTAREA_STYLE}
              />
            )}
            <textarea
              ref={composerRef}
              rows={2}
              placeholder="Ask anything about your sources, or type / for commands…"
              aria-label="Message"
              aria-busy={sending || undefined}
              className={slashOpen || slashMode ? 'ns-slash-input' : undefined}
              style={CHAT_TEXTAREA_STYLE}
              value={input}
              onChange={(e) => {
                onComposerChange(e.target.value)
                // Auto-grow up to maxHeight: clear height to recompute
                // scrollHeight, then size the box to fit content.
                const ta = e.currentTarget
                ta.style.height = 'auto'
                ta.style.height = `${Math.min(240, ta.scrollHeight)}px`
              }}
              onKeyDown={onKeyDown}
              disabled={sending}
            />
            {slashOpen && filteredSlash.length > 0 && (
              <div
                role="listbox"
                aria-label="Slash commands"
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  width: 320,
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 10,
                  boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
                  zIndex: 10,
                  padding: 4,
                }}
              >
                {filteredSlash.map((cmd, i) => (
                  <button
                    key={cmd.label}
                    type="button"
                    role="option"
                    aria-selected={i === slashCursor}
                    onMouseEnter={() => setSlashCursor(i)}
                    onClick={() => pickSlash(cmd)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 2,
                      padding: '8px 10px',
                      width: '100%',
                      border: 'none',
                      background:
                        i === slashCursor
                          ? 'var(--color-paper-2)'
                          : 'transparent',
                      cursor: 'pointer',
                      borderRadius: 6,
                      fontFamily: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      className="font-mono"
                      style={{ fontSize: 12.5, color: 'var(--color-ink)' }}
                    >
                      {cmd.label}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--color-muted)' }}>
                      {cmd.hint}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              position: 'relative',
              flexWrap: 'wrap',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              style={{ display: 'none' }}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length === 0 || !projectId) return
                e.target.value = ''
                setUploading(true)
                  const modelToSend = await resolveUploadModelForRequest()
                  for (const f of files) {
                  // +1 before the API round-trip, -1 in the finally
                  // below so the host's upload-view denominator stays
                  // honest about how many files are still uploading.
                  onUploadAttempt?.(1)
                  try {
                    const fd = new FormData()
                    fd.append('project_id', projectId)
                    fd.append('file', f)
                    if (modelToSend) fd.append('model', modelToSend)
                    const ok = await apiForm<{
                      material_id?: string
                      job_id?: string | null
                    }>('/materials/ingest-pdf', fd, { auth: true })
                    onMaterialIngested?.()
                    if (ok?.material_id) {
                      onIngestionStarted?.({
                        materialId: ok.material_id,
                        jobId: ok.job_id ?? null,
                        label: f.name,
                      })
                    }
                  } catch (err) {
                    const e = err as ApiError
                    const code = e.code
                    toast.error(
                      code === 'embedding_provider_unavailable'
                        ? "Source indexing needs an embedding provider — add OpenAI, Google, or a custom embedding endpoint in Settings."
                        : code === 'not_a_pdf'
                          ? `${f.name} isn't a PDF.`
                          : code === 'file_too_large'
                            ? `${f.name} is over 50 MB.`
                            : code === 'empty_pdf'
                              ? `Couldn't read text from ${f.name}.`
                              : `Upload error for ${f.name}: ${
                                  err instanceof Error ? err.message : 'unknown'
                                }`,
                    )
                  } finally {
                    onUploadAttempt?.(-1)
                  }
                }
                setUploading(false)
              }}
            />
            <div ref={commandMenuWrapRef} style={{ position: 'relative' }}>
              <button
                ref={commandMenuTriggerRef}
                type="button"
                className="ns-btn ghost tiny"
                onClick={() => {
                  setCommandMenuOpen((o) => !o)
                  setAttachOpen(false)
                  setSourcePickerOpen(false)
                }}
                aria-haspopup="listbox"
                aria-expanded={commandMenuOpen}
                aria-controls={commandMenuId}
                aria-label="Open slash commands"
                title="Open slash commands"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span
                  aria-hidden
                  className="font-mono"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: 'var(--color-paper-2)',
                    color: 'var(--color-ink-2)',
                    fontSize: 12,
                    lineHeight: 1,
                    fontWeight: 700,
                  }}
                >
                  /
                </span>
                <span>Commands</span>
              </button>
              {commandMenuOpen && (
                <div
                  id={commandMenuId}
                  role="listbox"
                  aria-label="Slash commands"
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    width: 320,
                    background: '#fff',
                    border: '1px solid var(--color-rule)',
                    borderRadius: 10,
                    boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
                    zIndex: 10,
                    padding: 4,
                  }}
                >
                  {SLASH_COMMANDS.map((cmd) => (
                    <button
                      key={cmd.label}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        pickSlash(cmd)
                        setCommandMenuOpen(false)
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 2,
                        padding: '8px 10px',
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        borderRadius: 6,
                        fontFamily: 'inherit',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = 'var(--color-paper-2)')
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = 'transparent')
                      }
                    >
                      <span
                        className="font-mono"
                        style={{ fontSize: 12.5, color: 'var(--color-ink)' }}
                      >
                        {cmd.label}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--color-muted)' }}>
                        {cmd.hint}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div ref={attachWrapRef} style={{ position: 'relative' }}>
            <button
              ref={attachTriggerRef}
              type="button"
              className="ns-btn ghost tiny"
              disabled={uploading || !projectId}
              aria-busy={uploading || undefined}
              onClick={() => setAttachOpen((o) => !o)}
              aria-label="Add a source"
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              aria-controls={attachMenuId}
              title="Add a new source for this chat — Upload PDF or paste a URL"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {uploading ? (
                <span className="spinner" aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className="font-mono"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    background: 'var(--color-paper-2)',
                    color: 'var(--color-ink-2)',
                    fontSize: 12,
                    lineHeight: 1,
                    fontWeight: 600,
                  }}
                >
                  +
                </span>
              )}
              <span>Add source</span>
            </button>
            {attachOpen && (
              <div
                id={attachMenuId}
                role="menu"
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  width: 240,
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 10,
                  boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
                  zIndex: 10,
                  padding: 6,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="ns-btn ghost tiny"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => {
                    setAttachOpen(false)
                    fileInputRef.current?.click()
                  }}
                >
                  <Icons.pdf size={12} /> Upload PDF…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ns-btn ghost tiny"
                  style={{ width: '100%', justifyContent: 'flex-start', marginTop: 4 }}
                  onClick={() => {
                    setAttachOpen(false)
                    setUrlValue('')
                    setUrlPromptOpen(true)
                  }}
                >
                  <Icons.doc size={12} /> Add from URL…
                </button>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--color-muted)',
                    padding: '6px 8px 2px',
                    lineHeight: 1.4,
                  }}
                >
                  arXiv links auto-detect the PDF + metadata.
                </div>
              </div>
            )}
            </div>
            {urlPromptOpen && (
              <div
                role="dialog"
                aria-label="Add a URL source"
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  width: 360,
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 10,
                  boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
                  zIndex: 10,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  aria-hidden
                  className="font-mono"
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.08em',
                    color: 'var(--color-muted)',
                    textTransform: 'uppercase',
                  }}
                >
                  Add a URL source
                </div>
                <input
                  autoFocus
                  type="url"
                  className="ns-input"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="https://arxiv.org/abs/2401.12345"
                  aria-label="URL to add as a source"
                  value={urlValue}
                  onChange={(e) => setUrlValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setUrlPromptOpen(false)
                      // The URL input unmounts, so focus would dangle —
                      // hand it back to the attach trigger that opened
                      // this flow.
                      attachTriggerRef.current?.focus()
                    }
                    if (e.key === 'Enter' && isLikelyHttpUrl(urlValue)) {
                      e.preventDefault()
                      void submitUrl()
                    }
                  }}
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="ns-btn ghost tiny"
                    onClick={() => {
                      setUrlPromptOpen(false)
                      attachTriggerRef.current?.focus()
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ns-btn tiny"
                    disabled={uploading || !isLikelyHttpUrl(urlValue)}
                    aria-busy={uploading || undefined}
                    onClick={() => void submitUrl()}
                  >
                    {uploading ? 'Fetching…' : 'Add'}
                  </button>
                </div>
              </div>
            )}
            <div ref={sourcePickerWrapRef} style={{ position: 'relative' }}>
            <button
              ref={sourcePickerTriggerRef}
              type="button"
              className="ns-btn ghost tiny"
              onClick={() => setSourcePickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={sourcePickerOpen}
              aria-controls={sourcePickerId}
              aria-label="Mention an existing source"
              title="Cite an existing source from this project"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <span
                aria-hidden
                className="font-mono"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: 'var(--color-paper-2)',
                  color: 'var(--color-ink-2)',
                  fontSize: 10,
                  lineHeight: 1,
                  fontWeight: 600,
                }}
              >
                @
              </span>
              <span>Mention source</span>
            </button>
            {sourcePickerOpen && materials.length > 0 && (
              <div
                id={sourcePickerId}
                role="listbox"
                aria-label="Sources to mention"
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  width: 320,
                  maxHeight: 240,
                  overflow: 'auto',
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 10,
                  boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
                  zIndex: 10,
                  padding: 6,
                }}
              >
                {materials.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      const tag = `@${(m.title ?? 'untitled').replace(/\s+/g, '-')} `
                      setInput((cur) => (cur ? cur + ' ' + tag : tag))
                      setSourcePickerOpen(false)
                      composerRef.current?.focus()
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
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = 'var(--color-paper-2)')
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = 'transparent')
                    }
                  >
                    {m.source_type === 'pdf' ? (
                      <Icons.pdf size={12} />
                    ) : m.source_type === 'url' ? (
                      <Icons.doc size={12} />
                    ) : (
                      <Icons.note size={12} />
                    )}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.title ?? 'Untitled'}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {sourcePickerOpen && materials.length === 0 && (
              <div
                role="status"
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  padding: '8px 10px',
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 10,
                  fontSize: 12.5,
                  color: 'var(--color-muted)',
                  boxShadow: '0 16px 32px rgba(0,0,0,0.12)',
                  zIndex: 10,
                  whiteSpace: 'nowrap',
                }}
              >
                No sources yet — drop a PDF or paste a URL.
              </div>
            )}
            </div>
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <button
                type="button"
                className="ns-btn tiny"
                onClick={() => setMemoryIncognito((v) => !v)}
                aria-pressed={memoryIncognito}
                title={
                  memoryIncognito
                    ? 'Incognito: this message will not read or write memory. Click to disable for the next send.'
                    : 'Send this message in incognito mode — skip memory read AND write for this turn.'
                }
                aria-label="Incognito memory toggle"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.02em',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'lowercase',
                  ...(memoryIncognito
                    ? {
                        background:
                          'color-mix(in oklch, var(--color-indigo) 14%, transparent)',
                        color: 'var(--color-indigo)',
                        borderColor:
                          'color-mix(in oklch, var(--color-indigo) 36%, transparent)',
                      }
                    : {}),
                }}
              >
                {memoryIncognito ? 'incognito ·on' : 'incognito'}
              </button>
              <button
                type="button"
                className="ns-btn tiny"
                onClick={toggleRetrievalMode}
                aria-pressed={retrievalMode === 'tree'}
                title={
                  retrievalMode === 'tree'
                    ? 'Reasoning-based retrieval (PageIndex tree-walk). Click to switch to vector kNN.'
                    : 'Vector retrieval (pgvector kNN). Click to switch to reasoning-based tree-walk.'
                }
                aria-label="Retrieval mode toggle"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.02em',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'lowercase',
                }}
              >
                {retrievalMode === 'tree' ? 'reasoning' : 'vector'}
              </button>
              <ModelPill value={selectedModel} onChange={updateSelectedModel} />
              <button
                type="button"
                onClick={() => {
                  if (sending) abortRef.current?.abort()
                  else void submit()
                }}
                disabled={!sending && !input.trim()}
                aria-busy={sending || undefined}
                aria-keyshortcuts="Enter Meta+Enter Control+Enter"
                aria-label={sending ? 'Stop generating' : 'Send message'}
                title={sending ? 'Stop generating' : 'Send (Enter · Shift+Enter for a new line)'}
                style={{
                  width: 32,
                  height: 32,
                  padding: 0,
                  borderRadius: 999,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: sending
                    ? 'var(--color-error)'
                    : !input.trim()
                      ? 'var(--color-paper-2)'
                      : 'var(--color-indigo)',
                  color: sending || input.trim() ? '#fff' : 'var(--color-muted)',
                  border: `1px solid ${sending ? 'var(--color-error)' : !input.trim() ? 'var(--color-rule)' : 'var(--color-indigo)'}`,
                  cursor: sending || input.trim() ? 'pointer' : 'not-allowed',
                  transition: 'background 120ms ease, color 120ms ease',
                }}
              >
                {sending ? (
                  <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>■</span>
                ) : (
                  <Icons.send size={13} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </section>
  )
}

/**
 * True when message `i` is an AI reply that ends its turn — i.e. no
 * *later* AI message precedes the next human message. A single user
 * turn can produce several AI messages (an intermediate "let me
 * check…" step, then the answer after a tool call); the action row
 * (feedback + notesci mark) should sign only the turn's final answer,
 * never get inserted between the steps of one answer.
 */
function isLastReply(messages: ChatMessage[], i: number): boolean {
  if (messages[i].role !== 'ai') return false
  for (let j = i + 1; j < messages.length; j++) {
    const r = messages[j].role
    if (r === 'ai') return false // a later reply in this same turn exists
    if (r === 'human') return true // the next turn has started
    // 'tool' / 'system' — part of the same turn; keep scanning.
  }
  return true // reached the end of the conversation
}

function MessageRow({
  m,
  isLastReply: showActions,
  isContinuation,
  onOpenReader,
  onJumpToCitation,
  onOpenExternalSource,
  onSendToDraft,
  onLinkClick,
}: {
  m: ChatMessage
  /** True only for the turn's final AI message — gates the action row. */
  isLastReply: boolean
  /** True when this AI message continues a turn already in progress
   *  (it follows a tool result or another AI message, not a human
   *  prompt) — used to tighten the gap so a multi-step answer reads as
   *  one block. */
  isContinuation: boolean
  onOpenReader?: (materialId: string | null) => void
  onJumpToCitation?: (detail: CitationClick) => void
  onOpenExternalSource?: (url: string) => void
  onSendToDraft?: (text: string) => void
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
}) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const toast = useToast()
  const externalSources = (m.retrieved ?? []).filter(
    (r) =>
      r.material_url &&
      (r.source_kind === 'external' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.material_id)),
  )
  if (m.role === 'system' || m.role === 'tool') return null

  // ── Human turn — the "V2 · Quote" prompt block, right-aligned.
  //    Editorial pull-quote: no card, no bubble, no fill. A hairline
  //    rule with a brand-indigo top cap marks the user's voice; the
  //    body is italic serif so question and answer share one voice.
  //    Adjusted from the standalone handoff: the block sits on the
  //    right of the column, the rule is a flex sibling so it spans
  //    exactly the text height (proportional, not padding-inflated),
  //    and the body size matches the AI reply (14.5px) for a
  //    consistent reading rhythm.
  if (m.role === 'human') {
    // Right-aligned soft card. Styling in .ns-chat-user / .ns-chat-user-body
    // (index.css), shared with General chat so both surfaces render the
    // same. Replaces the earlier bare hairline + italic pull-quote.
    return (
      <div role="article" aria-label="Your message" className="ns-chat-user">
        <div className="ns-chat-user-inner">
          <span aria-hidden className="ns-chat-user-rule" />
          <div className="ns-chat-user-body">{m.content}</div>
        </div>
      </div>
    )
  }

  const recalled = m.memory_recalled ?? []
  const recalledTitle =
    recalled.length > 0
      ? recalled
          .map(
            (memory) =>
              `${memory.scope} · ${memory.kind.replaceAll('_', ' ')} · ${
                memory.title
              }\n${memory.body}`,
          )
          .join('\n\n')
      : 'Long-term memory the agent recalled before answering'

  // ── AI turn — full-width, left-aligned, no avatar / no "notesci"
  //    header label / no model subscript. A small notesci mark signs
  //    the reply at the bottom instead.
  return (
    <div
      role="article"
      aria-label="notesci reply"
      className="ns-chat-ai"
      style={{
        // Extra top margin (on top of the conversation body's gap:20)
        // opens a deliberate distance between the user's prompt above
        // and this answer. A continuation message (a later step of the
        // same turn — e.g. the answer after a tool call) skips it so
        // the multi-step reply reads as one block, not separate turns.
        marginTop: isContinuation ? 0 : 14,
      }}
    >
      <div className="font-serif md-body ns-chat-ai-body">
        <Markdown
          text={m.content}
          retrieved={m.retrieved ?? []}
          onClickCitation={(detail) => {
            if (onJumpToCitation) onJumpToCitation(detail)
            else onOpenReader?.(detail.materialId)
          }}
          onLinkClick={onLinkClick}
        />
        {((m.skills && m.skills.length > 0) || (m.memory_recalled_count ?? 0) > 0) && (
          <div
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}
            aria-label="Active capabilities for this reply"
          >
            {(m.memory_recalled_count ?? 0) > 0 && (
              <span
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  padding: '2px 8px',
                  borderRadius: 999,
                  background:
                    'color-mix(in oklch, var(--color-teal) 12%, transparent)',
                  color: 'var(--color-teal)',
                  textTransform: 'uppercase',
                }}
                title={recalledTitle}
              >
                ✦ Recalled {m.memory_recalled_count} note
                {(m.memory_recalled_count ?? 0) === 1 ? '' : 's'}
              </span>
            )}
            {m.skills?.map((sid) => {
              const label = SKILL_LABELS[sid] ?? sid
              return (
                <span
                  key={sid}
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    padding: '2px 8px',
                    borderRadius: 999,
                    background:
                      'color-mix(in oklch, var(--color-indigo) 10%, transparent)',
                    color: 'var(--color-indigo)',
                    textTransform: 'uppercase',
                  }}
                  title="notesci tuned this reply for the task"
                >
                  ✦ {label}
                </span>
              )
            })}
          </div>
        )}
        {externalSources.length > 0 && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              border: '1px solid var(--color-rule)',
              borderRadius: 12,
              background: 'color-mix(in oklch, var(--color-paper) 82%, white)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
            aria-label="External web sources"
          >
            <div
              className="font-mono"
              style={{
                fontSize: 10,
                color: 'var(--color-muted)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Web sources
            </div>
            {externalSources.map((source, index) => (
              <button
                key={`${source.material_url}-${index}`}
                type="button"
                onClick={() => {
                  if (source.material_url) onOpenExternalSource?.(source.material_url)
                }}
                title={source.material_url ?? source.title ?? 'External source'}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  width: '100%',
                  border: 'none',
                  background: 'transparent',
                  padding: '4px 0',
                  textAlign: 'left',
                  cursor: source.material_url ? 'pointer' : 'default',
                  color: 'var(--color-ink)',
                  font: 'inherit',
                }}
              >
                <span
                  className="font-mono"
                  style={{
                    fontSize: 11,
                    color: 'var(--color-muted)',
                    flex: '0 0 auto',
                  }}
                >
                  W{source.marker_n ?? index + 1}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: source.material_url ? 'var(--color-indigo)' : 'var(--color-muted)',
                      textDecoration: source.material_url ? 'underline' : 'none',
                      textUnderlineOffset: 3,
                    }}
                  >
                    {source.title || 'External source'}
                  </span>
                  {source.material_url && (
                    <span
                      className="font-mono"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--color-muted)',
                        fontSize: 10.5,
                      }}
                    >
                      {source.material_url}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action row — thumb feedback · Save as draft · retrieved-source
          count · notesci mark. Rendered ONLY on the turn's final AI
          message (`showActions`) so it signs the answer and is never
          inserted between the steps of a tool-loop reply. */}
      {showActions && (
        <div
          role="toolbar"
          aria-label="Reply actions"
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
            aria-pressed={feedback === 'up'}
            aria-label={feedback === 'up' ? 'Marked as helpful' : 'Mark as helpful'}
            title="Helpful"
            style={{
              padding: '5px 7px',
              color: feedback === 'up' ? 'var(--color-teal)' : undefined,
              borderColor:
                feedback === 'up'
                  ? 'color-mix(in oklch, var(--color-teal) 35%, transparent)'
                  : undefined,
              background:
                feedback === 'up'
                  ? 'color-mix(in oklch, var(--color-teal) 9%, transparent)'
                  : undefined,
            }}
          >
            <Icons.thumbUp size={13} />
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
            aria-pressed={feedback === 'down'}
            aria-label={feedback === 'down' ? 'Marked as not helpful' : 'Mark as not helpful'}
            title="Not helpful"
            style={{
              padding: '5px 7px',
              color: feedback === 'down' ? 'var(--color-error)' : undefined,
              borderColor:
                feedback === 'down'
                  ? 'color-mix(in oklch, var(--color-error) 35%, transparent)'
                  : undefined,
              background:
                feedback === 'down'
                  ? 'color-mix(in oklch, var(--color-error) 9%, transparent)'
                  : undefined,
            }}
          >
            <Icons.thumbDown size={13} />
          </button>
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => {
              if (!onSendToDraft) {
                toast.warn('Open a project to save replies as drafts.')
                return
              }
              onSendToDraft(m.content)
            }}
            title="Preview this reply as a draft — save to Draft library or export."
          >
            <Icons.doc size={11} /> Save as draft
          </button>
          {m.retrieved && m.retrieved.length > 0 && (
            <span
              className="font-mono"
              style={{
                fontSize: 10,
                color: 'var(--color-muted)',
                marginLeft: 'auto',
                letterSpacing: '0.06em',
              }}
            >
              {m.retrieved.length} source{m.retrieved.length === 1 ? '' : 's'}
              {typeof m.retrieved[0].distance === 'number'
                ? ` · top ${m.retrieved[0].distance.toFixed(2)}`
                : ''}
            </span>
          )}
          <div
            aria-hidden
            style={{
              display: 'flex',
              alignItems: 'center',
              marginLeft:
                m.retrieved && m.retrieved.length > 0 ? 10 : 'auto',
            }}
          >
            <Mark size={16} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Slide-in draft preview card. Anchored to the LEFT side of the chat
 * pane's conversation area. Shows the AI reply the user picked as
 * "Save as draft" and offers three terminal actions:
 *
 *   - Save to Draft — writes into the project's drafter (the Draft mode
 *     library) via the host's onSendToDraft callback.
 *   - Export — downloads a Markdown file of the content.
 *   - Dismiss — closes the card without keeping anything.
 *
 * The card is intentionally simple: a stack of [eyebrow · title ·
 * scrollable content · action row]. Width is fixed (360 px on
 * desktop, shrinks on narrow viewports via max-width: 50%).
 */
function DraftPreview({
  content,
  onSave,
  onExport,
  onDismiss,
}: {
  content: string
  onSave: () => void
  onExport: () => void
  onDismiss: () => void
}) {
  return (
    <aside
      aria-label="Draft preview"
      style={{
        width: 360,
        maxWidth: '50%',
        flexShrink: 0,
        borderRight: '1px solid var(--color-rule)',
        background: 'var(--color-paper-2)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <header
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--color-rule)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Icons.doc size={13} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.12em',
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
            }}
          >
            Draft preview
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.2 }}>
            From this reply
          </div>
        </div>
        <button
          type="button"
          className="ns-btn ghost tiny"
          style={{ padding: '4px 6px' }}
          aria-label="Dismiss preview"
          title="Dismiss"
          onClick={onDismiss}
        >
          <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>✕</span>
        </button>
      </header>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '14px 16px',
        }}
      >
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-serif)',
            fontSize: 13.5,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            color: 'var(--color-ink)',
          }}
        >
          {content}
        </pre>
      </div>
      <footer
        style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--color-rule)',
          background: '#fff',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          className="ns-btn"
          onClick={onSave}
          style={{ fontSize: 12, padding: '6px 12px' }}
        >
          Save to Draft
        </button>
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={onExport}
        >
          <Icons.download size={11} /> Export
        </button>
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={onDismiss}
          style={{ marginLeft: 'auto' }}
        >
          Dismiss
        </button>
      </footer>
    </aside>
  )
}
