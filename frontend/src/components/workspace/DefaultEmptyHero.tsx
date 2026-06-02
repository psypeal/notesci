/**
 * "New session" landing for the Chat workspace layout — shown when
 * the user has a project + materials but no active session yet.
 *
 * The screen is intentionally sparse: just the headline + the
 * composer card. One rotating placeholder cycles through a mixed
 * pool of example prompts AND slash-command hints, so users
 * discover slash commands without a second carousel competing for
 * attention.
 *
 * When the user starts typing `/word`, a colorful slash-mode chip
 * surfaces above the composer with the matched command's hint plus
 * a "space + your prompt" guide so first-time users understand the
 * sigil.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Icons } from '../icons'
import { ModelPill } from './ModelPill'
import { patchPrefs, readPrefs } from '../../lib/prefs'
import { buildSlashCommands, isLikelyHttpUrl, type SlashCommand } from './ChatPane'
import { SlashMirror, detectSlashMode } from './SlashMode'
import { api, apiForm, type ApiError } from '../../lib/api'
import { getProviders, resolveUploadModel } from '../../lib/models'
import { useToast } from '../Toast'

const PLACEHOLDER_ROTATE_MS = 4000

/** Shared between the real <textarea> and the SlashMirror layer so
 *  the painted tokens line up exactly under the textarea's caret.
 *  Any change to font/line-height/padding must be applied to BOTH. */
const HERO_TEXTAREA_STYLE: React.CSSProperties = {
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

export function DefaultEmptyHero({
  materials = [],
  onLaunch,
  projectId,
  onMaterialIngested,
  onIngestionStarted,
  onUploadAttempt,
}: {
  /** Used to localize the carousel placeholders. Empty list is fine. */
  materials?: { id?: string; title: string | null; source_type?: string }[]
  /** Receives the prompt text the user wants to send. */
  onLaunch: (prompt: string) => void
  /** Project to ingest new sources into when "+" is used. */
  projectId?: string | null
  /** Called after a successful PDF / URL ingest. */
  onMaterialIngested?: () => void
  /** Optional pipeline-tracking hook for the source-ingest spinner. */
  onIngestionStarted?: (info: { materialId: string; jobId: string | null; label: string }) => void
  /** Per-upload delta (+1 before each API call, -1 in its finally) so
   *  the host can keep an honest "still uploading N files" counter
   *  even when files are dispatched sequentially. */
  onUploadAttempt?: (delta: 1 | -1) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null)
  const attachWrapRef = useRef<HTMLDivElement | null>(null)
  const commandMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const commandMenuWrapRef = useRef<HTMLDivElement | null>(null)
  const sourcePickerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sourcePickerWrapRef = useRef<HTMLDivElement | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [urlPromptOpen, setUrlPromptOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const attachMenuId = useId()
  const commandMenuId = useId()
  const sourcePickerId = useId()

  const resolveModelForRequest = async (): Promise<string | null> => {
    const preferred = selectedModel
    const catalog = await getProviders().catch(() => null)
    return resolveUploadModel(preferred, catalog)
  }

  useEffect(() => {
    if (!attachOpen && !commandMenuOpen && !sourcePickerOpen && !urlPromptOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (attachWrapRef.current?.contains(t)) return
      if (commandMenuWrapRef.current?.contains(t)) return
      if (sourcePickerWrapRef.current?.contains(t)) return
      setAttachOpen(false)
      setCommandMenuOpen(false)
      setSourcePickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAttachOpen(false)
        setCommandMenuOpen(false)
        setSourcePickerOpen(false)
        setUrlPromptOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [attachOpen, commandMenuOpen, sourcePickerOpen, urlPromptOpen])

  const submitUrl = async () => {
    const url = urlValue.trim()
    if (!url || !projectId) return
    setUploading(true)
    const modelToSend = await resolveModelForRequest()
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
            ...(modelToSend ? { model: modelToSend } : {}),
          }),
        },
      )
      setUploadError(null)
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
    } catch (err) {
      const e = err as ApiError
      setUploadError(
        e.code === 'url_not_allowed'
          ? "That URL isn't allowed."
          : e.code === 'url_fetch_failed'
            ? "We couldn't fetch that URL."
            : `URL ingest failed (${e.status}).`,
      )
    } finally {
      setUploading(false)
      onUploadAttempt?.(-1)
    }
  }
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const [selectedModel, setSelectedModel] = useState<string | null>(
    () => readPrefs().defaultModel,
  )
  useEffect(() => {
    const onPrefs = () => setSelectedModel(readPrefs().defaultModel)
    window.addEventListener('notesci-prefs-changed', onPrefs)
    return () => window.removeEventListener('notesci-prefs-changed', onPrefs)
  }, [])
  const updateModel = (next: string | null) => {
    setSelectedModel(next)
    patchPrefs('defaultModel', next)
  }

  const slash: SlashCommand[] = buildSlashCommands(materials)
  const carousel = useMemo(
    () => buildMixedCarousel(materials, slash),
    [materials, slash],
  )

  // Single carousel that powers the textarea placeholder. Pauses
  // while the user is typing — the placeholder would just be hidden
  // by their input and the motion is distracting.
  useEffect(() => {
    if (draft.trim()) return
    const id = window.setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % Math.max(1, carousel.length))
    }, PLACEHOLDER_ROTATE_MS)
    return () => window.clearInterval(id)
  }, [draft, carousel.length])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = draft.trim()
    if (!t) return
    onLaunch(t)
  }

  const slashMode = detectSlashMode(draft, slash)
  const pickSlash = (cmd: SlashCommand) => {
    setDraft((cur) => {
      const token = `${cmd.label} `
      if (!cur.trim()) return token
      return cur.replace(/(?:^|\n)\/[\w-]*$/, (m) =>
        m.startsWith('\n') ? `\n${token}` : token,
      )
    })
    setCommandMenuOpen(false)
  }

  return (
    <div
      className="pane"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        padding: '88px 36px 36px',
        background: '#fff',
      }}
    >
      <div
        style={{
          margin: '0 auto',
          width: '100%',
          // Scale with the pane width so the composer doesn't look
          // marooned in white space when the user collapses the graph
          // pane and the chat takes the full pane. Min keeps it readable
          // on narrow panes; max caps so the textarea doesn't grow into
          // a 2000px line-length on ultrawide displays.
          maxWidth: 'clamp(640px, 60vw, 960px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
      >
        <h2
          className="font-serif"
          style={{
            fontSize: 38,
            lineHeight: 1.1,
            fontWeight: 500,
            letterSpacing: '-0.015em',
            margin: 0,
            color: 'var(--color-ink)',
            textAlign: 'center',
          }}
        >
          What are you trying to figure out?
        </h2>

        <form onSubmit={submit}>
          <div
            className="ns-hero-composer"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: '14px 14px 12px',
              background: '#fff',
              border: `1px solid ${slashMode ? 'var(--color-indigo)' : 'var(--color-rule)'}`,
              borderRadius: 14,
              boxShadow: slashMode
                ? '0 0 0 3px color-mix(in oklch, var(--color-indigo) 12%, transparent)'
                : '0 1px 2px rgba(0,0,0,0.03)',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            onFocusCapture={(e) => {
              if (slashMode) return
              const el = e.currentTarget as HTMLDivElement
              el.style.borderColor = 'var(--color-indigo)'
              el.style.boxShadow = '0 4px 18px rgba(82, 70, 220, 0.06)'
            }}
            onBlurCapture={(e) => {
              if (slashMode) return
              const el = e.currentTarget as HTMLDivElement
              el.style.borderColor = 'var(--color-rule)'
              el.style.boxShadow = '0 1px 2px rgba(0,0,0,0.03)'
            }}
          >
            <div
              style={{
                position: 'relative',
                minHeight: 60,
                maxHeight: 240,
              }}
            >
              <SlashMirror
                value={draft}
                placeholder={carousel[placeholderIdx] ?? ''}
                commands={slash}
                style={HERO_TEXTAREA_STYLE}
              />
              <textarea
                rows={3}
                autoFocus
                aria-label="Ask"
                placeholder={carousel[placeholderIdx] ?? ''}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // IME guard — Enter while an input-method
                  // composition is active confirms a candidate
                  // character (e.g. Chinese); it must not launch
                  // the chat and abort the user's input.
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    const t = draft.trim()
                    if (t) onLaunch(t)
                  }
                }}
                className="ns-slash-input"
                style={HERO_TEXTAREA_STYLE}
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                position: 'relative',
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
                  for (const f of files) {
                    onUploadAttempt?.(1)
                    try {
                      const fd = new FormData()
                      fd.append('project_id', projectId)
                      fd.append('file', f)
                      const modelToSend = await resolveModelForRequest()
                      if (modelToSend) {
                        fd.append('model', modelToSend)
                      }
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
                    {slash.map((cmd) => (
                      <button
                        key={cmd.label}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => pickSlash(cmd)}
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
                      spellCheck={false}
                      placeholder="https://arxiv.org/abs/2401.12345"
                      aria-label="URL to add as a source"
                      value={urlValue}
                      onChange={(e) => setUrlValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setUrlPromptOpen(false)
                          attachTriggerRef.current?.focus()
                        }
                        if (e.key === 'Enter' && isLikelyHttpUrl(urlValue)) {
                          e.preventDefault()
                          void submitUrl()
                        }
                      }}
                    />
                    {uploadError && (
                      <div
                        role="alert"
                        style={{ fontSize: 11.5, color: 'var(--color-error)' }}
                      >
                        {uploadError}
                      </div>
                    )}
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
              </div>
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
                  title="Reference an existing source from this project"
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
                    {materials.map((m, i) => (
                      <button
                        key={m.id ?? i}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => {
                          const tag = `@${(m.title ?? 'untitled').replace(/\s+/g, '-')} `
                          setDraft((cur) => (cur ? cur + ' ' + tag : tag))
                          setSourcePickerOpen(false)
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
                        <span
                          style={{
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
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
                    No sources yet — use + to add one.
                  </div>
                )}
              </div>
              <ModelPill value={selectedModel} onChange={updateModel} align="left" />
              <button
                type="submit"
                className="ns-btn"
                disabled={!draft.trim()}
                style={{
                  fontSize: 13,
                  padding: '8px 14px',
                  marginLeft: 'auto',
                  whiteSpace: 'nowrap',
                }}
                title="Start the session"
              >
                <Icons.send size={12} /> Send
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

/**
 * Mixed carousel content for the textarea placeholder. Alternates
 * concrete example prompts with slash-command hints so users see
 * both styles without a second rotating element competing.
 */
function buildMixedCarousel(
  materials: { title: string | null }[],
  commands: readonly SlashCommand[],
): string[] {
  const n = materials.length
  const first = materials[0]?.title
  const second = materials[1]?.title

  const examples: string[] = [
    "What's the dominant model in these papers, and where does it break down?",
    n >= 1
      ? `Summarize ${first ?? 'the first source'} in three sentences for a non-specialist.`
      : 'Summarize this collection for a non-specialist.',
    n >= 2
      ? `Compare ${first ?? 'the first source'} and ${second ?? 'the second source'} — methods, claims, disagreements.`
      : 'Compare the methods used to support the central claim.',
    'Which finding is best-supported and which is on the thinnest evidence?',
    'Draft an introduction paragraph that motivates the open question.',
  ]
  const slashHints = commands.map((c) => `Try ${c.label} — ${c.hint}`)

  // Interleave so the user sees an example, then a slash hint,
  // then an example, etc. Falls back gracefully if either list is
  // empty.
  const out: string[] = []
  const max = Math.max(examples.length, slashHints.length)
  for (let i = 0; i < max; i++) {
    if (i < examples.length) out.push(examples[i])
    if (i < slashHints.length) out.push(slashHints[i])
  }
  return out
}
