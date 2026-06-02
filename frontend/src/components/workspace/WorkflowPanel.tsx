import { useEffect, useState } from 'react'
import { Icons } from '../icons'
import { api, type ApiError } from '../../lib/api'
import { useToast } from '../Toast'
import { Modal } from '../Modal'
import { readPrefs } from '../../lib/prefs'
import {
  getProviders,
  modelShortLabel,
  peekProviders,
  subscribeProviders,
  type ProvidersAvailable,
} from '../../lib/models'

/**
 * Draft workflow runtime — pre-flight interview + live status panel
 * over the multi-stage pipeline (gather → draft → polish → review →
 * iterate). Mounts inline above the Drafter pane when there's a
 * current project + draft.
 */

interface WorkflowState {
  id: string
  draft_id: string
  project_id: string
  status: string
  iteration: number
  max_iterations: number
  raw_content: string | null
  polished_content: string | null
  final_content: string | null
  panel_votes: Vote[]
  events: TimelineEvent[]
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface Vote {
  name: string
  persona: string
  verdict: 'APPROVE' | 'REVISE'
  feedback: string
  duration_ms: number
  model?: string | null
}

interface TimelineEvent {
  at: string
  kind: string
  [k: string]: unknown
}

interface PanelMember {
  name: string
  persona: string
}

const DEFAULT_PANEL: PanelMember[] = [
  { name: 'Methodologist', persona: 'A rigorous reviewer who insists every claim is grounded in cited evidence.' },
  { name: 'Editor', persona: 'A senior science editor who enforces conciseness and a clear narrative arc.' },
  { name: 'Domain expert', persona: 'A practitioner in the paper\'s field who catches conceptual errors and missing context.' },
]

const TERMINAL = new Set(['approved', 'failed', 'cancelled'])
const STAGE_ORDER = [
  'gathering_materials',
  'drafting',
  'polishing',
  'reviewing',
  'revising',
] as const

const STAGE_LABEL: Record<string, string> = {
  interviewing: 'Interview',
  gathering_materials: 'Gather',
  drafting: 'Draft',
  polishing: 'Polish',
  reviewing: 'Review',
  revising: 'Revise',
  approved: 'Approved',
  failed: 'Failed',
  cancelled: 'Cancelled',
}


export function WorkflowPanel({
  draftId,
  projectId,
  onApplyFinal,
}: {
  draftId: string | null
  projectId: string | null
  /** Called with the workflow's final_content when the user accepts it. */
  onApplyFinal?: (text: string) => void
}) {
  const [wf, setWf] = useState<WorkflowState | null>(null)
  const [loading, setLoading] = useState(false)
  const [interviewOpen, setInterviewOpen] = useState(false)
  const toast = useToast()

  // Initial fetch — get the most recent workflow for this draft.
  useEffect(() => {
    if (!draftId) {
      setWf(null)
      return
    }
    let aborted = false
    void (async () => {
      try {
        const remote = await api<WorkflowState | null>(
          `/drafts/${draftId}/workflow`,
          { auth: true },
        )
        if (!aborted) setWf(remote)
      } catch {
        if (!aborted) setWf(null)
      }
    })()
    return () => {
      aborted = true
    }
  }, [draftId])

  // Live updates — poll every ~2s while the workflow is in flight.
  // Polling rather than SSE because EventSource can't carry the
  // Authorization header. Bandwidth is trivial (one tiny JSON per
  // tick), and the loop self-cancels when a terminal status arrives.
  useEffect(() => {
    if (!wf || TERMINAL.has(wf.status)) {
      return
    }
    if (!draftId) return
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      if (cancelled) return
      try {
        const remote = await api<WorkflowState | null>(
          `/drafts/${draftId}/workflow`,
          { auth: true },
        )
        if (cancelled || !remote) return
        setWf(remote)
        if (TERMINAL.has(remote.status)) return
      } catch {
        /* keep polling */
      }
      timer = window.setTimeout(tick, 2000)
    }
    timer = window.setTimeout(tick, 1500)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [draftId, wf?.status, wf?.id])

  const startWorkflow = async (prompt: string, interview: WorkflowInterview) => {
    if (!draftId) return
    setLoading(true)
    try {
      // The interview already carries optional per-stage model overrides.
      // The top-level `model` is the workflow-wide default — per-stage
      // entries fall back to it on the backend if they're null.
      const remote = await api<WorkflowState>(`/drafts/${draftId}/workflow`, {
        method: 'POST',
        auth: true,
        body: JSON.stringify({
          prompt,
          interview,
          model: readPrefs().defaultModel,
        }),
      })
      setWf(remote)
      setInterviewOpen(false)
      toast.success('Workflow started.')
    } catch (err) {
      const e = err as ApiError
      toast.error(`Workflow failed to start (${e?.status ?? '?'})`)
    } finally {
      setLoading(false)
    }
  }

  const cancelWorkflow = async () => {
    if (!draftId) return
    try {
      const remote = await api<WorkflowState>(
        `/drafts/${draftId}/workflow/cancel`,
        { method: 'POST', auth: true },
      )
      setWf(remote)
      toast.toast('Workflow cancelled.')
    } catch {
      toast.error('Cancel failed.')
    }
  }

  const isActive = wf && !TERMINAL.has(wf.status)
  const canStart = !!draftId && !!projectId && !isActive

  return (
    <section
      aria-label="Draft workflow"
      style={{
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 10,
        padding: 14,
        margin: '12px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icons.sparkles size={14} />
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          Drafting workflow
        </div>
        {wf && (
          <span
            className="font-mono"
            style={{
              fontSize: 10.5,
              padding: '2px 8px',
              borderRadius: 999,
              background: STATUS_BG[wf.status] ?? 'var(--color-paper-2)',
              color: STATUS_FG[wf.status] ?? 'var(--color-ink-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {STAGE_LABEL[wf.status] ?? wf.status}
            {!TERMINAL.has(wf.status) && ` · iter ${wf.iteration}/${wf.max_iterations}`}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {isActive && (
            <button
              type="button"
              className="ns-btn ghost tiny"
              onClick={cancelWorkflow}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="ns-btn tiny"
            disabled={!canStart || loading}
            onClick={() => setInterviewOpen(true)}
          >
            {wf ? 'Run again' : 'Start workflow'}
          </button>
        </div>
      </header>

      {wf && <StageStrip status={wf.status} iteration={wf.iteration} />}

      {wf?.error && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 6,
            background: 'color-mix(in oklch, var(--color-error) 8%, transparent)',
            color: 'var(--color-error)',
          }}
        >
          {wf.error}
        </div>
      )}

      {wf?.panel_votes && wf.panel_votes.length > 0 && (
        <PanelVotes votes={wf.panel_votes} />
      )}

      {wf?.events && wf.events.length > 0 && (
        <Timeline events={wf.events} />
      )}

      {wf?.final_content && (
        <div
          style={{
            background: 'var(--color-paper-2)',
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.08em',
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
            }}
          >
            Final · {wf.status}
          </div>
          <pre
            style={{
              margin: 0,
              fontFamily: 'var(--font-serif)',
              fontSize: 13.5,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {wf.final_content}
          </pre>
          {onApplyFinal && wf.status === 'approved' && (
            <button
              type="button"
              className="ns-btn tiny"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => onApplyFinal(wf.final_content!)}
            >
              Apply to draft
            </button>
          )}
        </div>
      )}

      {interviewOpen && (
        <InterviewModal
          onClose={() => setInterviewOpen(false)}
          onStart={startWorkflow}
          loading={loading}
        />
      )}
    </section>
  )
}


// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------


const STATUS_BG: Record<string, string> = {
  approved: 'color-mix(in oklch, var(--color-teal) 18%, transparent)',
  failed: 'color-mix(in oklch, var(--color-error) 14%, transparent)',
  cancelled: 'var(--color-paper-2)',
}
const STATUS_FG: Record<string, string> = {
  approved: 'var(--color-teal)',
  failed: 'var(--color-error)',
  cancelled: 'var(--color-muted)',
}


function StageStrip({ status }: { status: string; iteration: number }) {
  const currentIdx = STAGE_ORDER.indexOf(status as (typeof STAGE_ORDER)[number])
  return (
    <ol
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        gap: 6,
        fontSize: 11.5,
      }}
    >
      {STAGE_ORDER.slice(0, 4).map((s, i) => {
        const active = i === currentIdx
        const done =
          (currentIdx >= 0 && i < currentIdx) ||
          status === 'approved' ||
          (status === 'revising' && i <= 3)
        return (
          <li
            key={s}
            style={{
              flex: 1,
              padding: '6px 8px',
              borderRadius: 6,
              background: active
                ? 'var(--color-ink)'
                : done
                  ? 'color-mix(in oklch, var(--color-teal) 12%, transparent)'
                  : 'var(--color-paper-2)',
              color: active
                ? 'var(--color-paper)'
                : done
                  ? 'var(--color-ink)'
                  : 'var(--color-muted)',
              textAlign: 'center',
              fontWeight: active ? 600 : 400,
            }}
            aria-current={active ? 'step' : undefined}
          >
            {STAGE_LABEL[s]}
          </li>
        )
      })}
    </ol>
  )
}


function PanelVotes({ votes }: { votes: Vote[] }) {
  const approved = votes.filter((v) => v.verdict === 'APPROVE').length
  const [catalog, setCatalog] = useState<ProvidersAvailable | null>(() =>
    peekProviders(),
  )
  useEffect(() => subscribeProviders(setCatalog), [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        className="font-mono"
        style={{
          fontSize: 10.5,
          letterSpacing: '0.08em',
          color: 'var(--color-muted)',
          textTransform: 'uppercase',
        }}
      >
        Panel · {approved}/{votes.length} approved
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {votes.map((v) => (
          <li
            key={v.name}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              background: v.verdict === 'APPROVE'
                ? 'color-mix(in oklch, var(--color-teal) 8%, transparent)'
                : 'color-mix(in oklch, var(--color-warn) 8%, transparent)',
              fontSize: 12,
            }}
          >
            <span
              className="font-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.06em',
                padding: '1px 6px',
                borderRadius: 3,
                background: v.verdict === 'APPROVE' ? 'var(--color-teal)' : 'var(--color-warn)',
                color: '#fff',
                flexShrink: 0,
              }}
            >
              {v.verdict}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 500 }}>{v.name}</span>
                {v.model && (
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: '0.06em',
                      color: 'var(--color-muted)',
                      textTransform: 'uppercase',
                    }}
                    title={`Reviewer used ${v.model}`}
                  >
                    {modelShortLabel(v.model, catalog) ?? v.model}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--color-ink-2)', lineHeight: 1.45 }}>
                {v.feedback}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}


function Timeline({ events }: { events: TimelineEvent[] }) {
  const [catalog, setCatalog] = useState<ProvidersAvailable | null>(() =>
    peekProviders(),
  )
  useEffect(() => subscribeProviders(setCatalog), [])

  // The first `models_resolved` event tells us how the workflow's
  // top-level + per-stage models resolved. Surface it as a one-line
  // banner so the user sees, at a glance, which model handled what.
  const resolved = events.find((e) => e.kind === 'models_resolved')

  // Keep the timeline tight — show only the last 8 events. Older ones
  // stay accessible if/when we add a "show more" affordance.
  const tail = events.slice(-8)

  const lbl = (m: unknown) =>
    typeof m === 'string' ? (modelShortLabel(m, catalog) ?? m) : null

  return (
    <details
      style={{
        fontSize: 11.5,
        color: 'var(--color-muted)',
        borderTop: '1px solid var(--color-rule)',
        paddingTop: 8,
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        Timeline · {events.length} events
      </summary>
      {resolved && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'var(--color-paper-2)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            color: 'var(--color-ink-2)',
            fontSize: 11.5,
          }}
        >
          <ModelBadge label="Draft" model={lbl(resolved.draft)} />
          <ModelBadge label="Polish" model={lbl(resolved.polish)} />
          <ModelBadge label="Review" model={lbl(resolved.review)} />
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {tail.map((e, i) => (
          <li
            key={i}
            className="font-mono"
            style={{ fontSize: 10.5, letterSpacing: '0.04em' }}
          >
            {new Date(e.at).toLocaleTimeString()} · {e.kind}
            {e.iteration !== undefined ? ` (iter ${String(e.iteration)})` : ''}
            {e.reviewer ? ` · ${String(e.reviewer)} → ${String(e.verdict)}` : ''}
            {e.count !== undefined ? ` · ${String(e.count)} hits` : ''}
            {e.model && lbl(e.model) ? ` · ${lbl(e.model)}` : ''}
          </li>
        ))}
      </ul>
    </details>
  )
}


function ModelBadge({ label, model }: { label: string; model: string | null }) {
  if (!model) return null
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
      <span
        className="font-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.08em',
          color: 'var(--color-muted)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 11 }}>{model}</span>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Pre-flight interview modal — paragraph structure, word count, panel
// composition. All fields have safe defaults; the user can hit Start
// immediately to skip and run with the default panel.
// ---------------------------------------------------------------------------


interface WorkflowInterview {
  word_count: number
  paragraph_structure: string
  panel: PanelMember[]
  web_search: boolean
  target_material_count: number
  max_iterations: number
  style_notes: string
  /** Optional per-stage LLM overrides — null/empty = "use top-level model". */
  draft_model: string | null
  polish_model: string | null
  review_model: string | null
}


function InterviewModal({
  onClose,
  onStart,
  loading,
}: {
  onClose: () => void
  onStart: (prompt: string, interview: WorkflowInterview) => void
  loading: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [wordCount, setWordCount] = useState(800)
  const [structure, setStructure] = useState(
    'intro · 3-4 body paragraphs · conclusion',
  )
  const [styleNotes, setStyleNotes] = useState('')
  const [panel, setPanel] = useState<PanelMember[]>(DEFAULT_PANEL)
  const [webSearch, setWebSearch] = useState(true)
  const [targetMaterials, setTargetMaterials] = useState(5)
  const [maxIterations, setMaxIterations] = useState(5)
  // Per-stage model overrides. `null` means "use top-level workflow
  // model" (which itself falls back to server default).
  const [draftModel, setDraftModel] = useState<string | null>(null)
  const [polishModel, setPolishModel] = useState<string | null>(null)
  const [reviewModel, setReviewModel] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ProvidersAvailable | null>(() =>
    peekProviders(),
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  useEffect(() => {
    let alive = true
    void getProviders()
      .then((c) => {
        if (alive) setCatalog(c)
      })
      .catch(() => {
        /* offline / 401 — pickers stay disabled */
      })
    return subscribeProviders((c) => {
      if (alive) setCatalog(c)
    })
  }, [])

  const submit = () => {
    if (!prompt.trim()) return
    onStart(prompt.trim(), {
      word_count: wordCount,
      paragraph_structure: structure,
      panel: panel.filter((p) => p.name && p.persona),
      web_search: webSearch,
      target_material_count: targetMaterials,
      max_iterations: maxIterations,
      style_notes: styleNotes,
      draft_model: draftModel,
      polish_model: polishModel,
      review_model: reviewModel,
    })
  }

  return (
    <Modal
      title="Drafting workflow · pre-flight"
      onClose={onClose}
      width={620}
      dismissOnOverlayClick={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="What should the agent draft?">
          <textarea
            className="ns-input"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Write the introduction for a paper on second-generation tau PET tracers in early Alzheimer's diagnosis."
            autoFocus
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Word count">
            <input
              type="number"
              className="ns-input"
              value={wordCount}
              min={100}
              max={5000}
              onChange={(e) => setWordCount(Number(e.target.value) || 800)}
            />
          </Field>
          <Field label="Max revision rounds">
            <input
              type="number"
              className="ns-input"
              value={maxIterations}
              min={1}
              max={10}
              onChange={(e) => setMaxIterations(Number(e.target.value) || 5)}
            />
          </Field>
        </div>

        <Field label="Paragraph structure">
          <input
            type="text"
            className="ns-input"
            value={structure}
            onChange={(e) => setStructure(e.target.value)}
          />
        </Field>

        <Field label="Style notes (optional)">
          <input
            type="text"
            className="ns-input"
            value={styleNotes}
            onChange={(e) => setStyleNotes(e.target.value)}
            placeholder="e.g. Avoid jargon. Lead with the unmet clinical need."
          />
        </Field>

        <Field label={`Expert panel (${panel.length} reviewer${panel.length === 1 ? '' : 's'})`}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {panel.map((p, i) => (
              <li
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 1fr auto',
                  gap: 6,
                  alignItems: 'flex-start',
                }}
              >
                <input
                  className="ns-input"
                  value={p.name}
                  onChange={(e) =>
                    setPanel(panel.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                  aria-label={`Reviewer ${i + 1} name`}
                />
                <input
                  className="ns-input"
                  value={p.persona}
                  onChange={(e) =>
                    setPanel(panel.map((x, j) => (j === i ? { ...x, persona: e.target.value } : x)))
                  }
                  aria-label={`Reviewer ${i + 1} persona`}
                />
                <button
                  type="button"
                  className="ns-btn ghost tiny"
                  onClick={() => setPanel(panel.filter((_, j) => j !== i))}
                  aria-label="Remove reviewer"
                  style={{ padding: '4px 8px' }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ns-btn ghost tiny"
            style={{ marginTop: 6, alignSelf: 'flex-start' }}
            onClick={() =>
              setPanel([
                ...panel,
                { name: 'Reviewer ' + (panel.length + 1), persona: '' },
              ])
            }
            disabled={panel.length >= 6}
          >
            + Add reviewer
          </button>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Min materials before drafting">
            <input
              type="number"
              className="ns-input"
              value={targetMaterials}
              min={0}
              max={20}
              onChange={(e) => setTargetMaterials(Number(e.target.value) || 0)}
            />
          </Field>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              alignSelf: 'flex-end',
              padding: '8px 0',
            }}
          >
            <input
              type="checkbox"
              checked={webSearch}
              onChange={(e) => setWebSearch(e.target.checked)}
            />
            Auto web-search if materials are scarce
          </label>
        </div>

        <div
          style={{
            borderTop: '1px solid var(--color-rule)',
            paddingTop: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: 'var(--color-muted)',
              fontSize: 11.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
            className="font-mono"
          >
            {showAdvanced ? <Icons.chevDown size={11} /> : <Icons.chevRight size={11} />}
            Per-stage models · advanced
          </button>
          {showAdvanced && (
            <div
              style={{
                marginTop: 10,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 10,
              }}
            >
              <Field label="Draft">
                <StagePicker
                  value={draftModel}
                  onChange={setDraftModel}
                  catalog={catalog}
                  suggestedFor="draft"
                />
              </Field>
              <Field label="Polish">
                <StagePicker
                  value={polishModel}
                  onChange={setPolishModel}
                  catalog={catalog}
                  suggestedFor="polish"
                />
              </Field>
              <Field label="Review panel">
                <StagePicker
                  value={reviewModel}
                  onChange={setReviewModel}
                  catalog={catalog}
                  suggestedFor="review"
                />
              </Field>
            </div>
          )}
          {showAdvanced && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--color-muted)',
                marginTop: 8,
                lineHeight: 1.45,
              }}
            >
              Each stage falls back to your default model when set to "Use
              workspace default". A common cost-conscious recipe is{' '}
              <em>Sonnet</em> for drafting, <em>GPT-5</em> for polish, and the
              cheapest available model for the reviewer panel.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="ns-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ns-btn"
            onClick={submit}
            disabled={loading || !prompt.trim()}
            aria-busy={loading || undefined}
          >
            {loading ? 'Starting…' : 'Start workflow'}
          </button>
        </div>
      </div>
    </Modal>
  )
}


function StagePicker({
  value,
  onChange,
  catalog,
  suggestedFor,
}: {
  value: string | null
  onChange: (v: string | null) => void
  catalog: ProvidersAvailable | null
  suggestedFor: string
}) {
  return (
    <select
      className="ns-input"
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === '' ? null : v)
      }}
      aria-label={`Model for ${suggestedFor} stage`}
    >
      <option value="">Use workspace default</option>
      {catalog?.providers.map((p) => {
        const ms = catalog.models.filter((m) => m.provider_id === p.id)
        if (ms.length === 0) return null
        return (
          <optgroup key={p.id} label={p.display_name}>
            {ms.map((m) => {
              const suggested = m.suggested_for.includes(suggestedFor)
              return (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}
                  {suggested ? ' · suggested' : ''}
                  {m.kind === 'reasoning' ? ' · reasoning' : ''}
                </option>
              )
            })}
          </optgroup>
        )
      })}
    </select>
  )
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label
        className="font-mono"
        style={{
          fontSize: 10.5,
          letterSpacing: '0.08em',
          color: 'var(--color-muted)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  )
}
