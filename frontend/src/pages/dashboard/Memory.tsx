import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  PageHeader,
  PageScaffold,
  SectionCard,
} from '../../components/dashboard/PageScaffold'
import { api, errorMessage } from '../../lib/api'
import { useMe, userCard } from './useMe'
import { useToast } from '../../components/Toast'
import { Modal } from '../../components/Modal'

/**
 * Settings → Research → Memory.
 *
 * Two surfaces:
 *   1) General core block — pinned in every General chat's system prompt.
 *   2) Per-project core block — pinned in that project's chats only.
 *
 * Core is the cheapest, highest-leverage memory channel; extracted
 * facts are the reviewable rows the agent can recall opportunistically.
 */

interface CoreOut {
  scope: 'general' | 'project'
  project_id: string | null
  title: string
  body: string
  updated_at: string | null
}

interface ProjectLite {
  id: string
  name: string
  updated_at: string
}

interface MemoryRowOut {
  id: string
  scope: 'general' | 'project'
  project_id: string | null
  kind: 'core' | 'preference' | 'project_fact' | 'open_question' | 'reference'
  title: string
  body: string
  source_session: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  confidence: string | null
  last_recalled_at: string | null
}

const KIND_LABEL: Record<MemoryRowOut['kind'], string> = {
  core: 'Core',
  preference: 'Preference',
  project_fact: 'Project fact',
  open_question: 'Open question',
  reference: 'Reference',
}

const EDITABLE_KINDS: MemoryRowOut['kind'][] = [
  'preference',
  'project_fact',
  'open_question',
  'reference',
]

type FactDraft = {
  mode: 'create' | 'edit'
  id?: string
  kind: MemoryRowOut['kind']
  title: string
  body: string
}

export function MemoryPage() {
  const { me } = useMe()
  const toast = useToast()
  const [projects, setProjects] = useState<ProjectLite[] | null>(null)
  const [scope, setScope] = useState<'general' | 'project'>('general')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [core, setCore] = useState<CoreOut | null>(null)
  const [draft, setDraft] = useState('')
  const [savedBody, setSavedBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [facts, setFacts] = useState<MemoryRowOut[] | null>(null)
  const [factsRefreshTick, setFactsRefreshTick] = useState(0)
  const [factDraft, setFactDraft] = useState<FactDraft | null>(null)
  const [factSaving, setFactSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const ps = await api<ProjectLite[]>('/projects', { auth: true })
        setProjects(ps)
      } catch {
        setProjects([])
      }
    })()
  }, [])

  useEffect(() => {
    setLoading(true)
    const qs =
      scope === 'project'
        ? `?scope=project&project_id=${projectId ?? ''}`
        : `?scope=general`
    if (scope === 'project' && !projectId) {
      setCore(null)
      setDraft('')
      setSavedBody('')
      setLoading(false)
      return
    }
    void (async () => {
      try {
        const c = await api<CoreOut>(`/memories/core${qs}`, { auth: true })
        setCore(c)
        setDraft(c.body)
        setSavedBody(c.body)
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't load memory."))
        setCore(null)
        setDraft('')
        setSavedBody('')
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, projectId])

  // Load extracted facts (non-core rows) for this scope.
  useEffect(() => {
    if (scope === 'project' && !projectId) {
      setFacts([])
      return
    }
    const qs =
      scope === 'project'
        ? `?scope=project&project_id=${projectId ?? ''}`
        : '?scope=general'
    void (async () => {
      try {
        const rows = await api<MemoryRowOut[]>(`/memories${qs}`, {
          auth: true,
        })
        setFacts(rows.filter((r) => r.kind !== 'core'))
      } catch {
        setFacts([])
      }
    })()
  }, [scope, projectId, factsRefreshTick])

  const archive = async (id: string) => {
    try {
      await api(`/memories/${id}`, { method: 'DELETE', auth: true })
      setFacts((rows) => rows?.filter((r) => r.id !== id) ?? null)
      toast.success('Memory archived.')
    } catch (err) {
      toast.error(errorMessage(err, 'Archive failed.'))
    }
  }

  const openCreateFact = () => {
    setFactDraft({
      mode: 'create',
      kind: scope === 'project' ? 'project_fact' : 'preference',
      title: '',
      body: '',
    })
  }

  const openEditFact = (fact: MemoryRowOut) => {
    setFactDraft({
      mode: 'edit',
      id: fact.id,
      kind: fact.kind,
      title: fact.title,
      body: fact.body,
    })
  }

  const saveFact = async (e: FormEvent) => {
    e.preventDefault()
    if (!factDraft || factSaving) return
    if (!factDraft.title.trim() || !factDraft.body.trim()) return
    if (scope === 'project' && !projectId) return
    setFactSaving(true)
    try {
      if (factDraft.mode === 'create') {
        const created = await api<MemoryRowOut>('/memories', {
          method: 'POST',
          auth: true,
          body: JSON.stringify({
            scope,
            project_id: scope === 'project' ? projectId : null,
            kind: factDraft.kind,
            title: factDraft.title,
            body: factDraft.body,
          }),
        })
        setFacts((rows) => {
          const withoutDup = (rows ?? []).filter((r) => r.id !== created.id)
          return [created, ...withoutDup]
        })
        toast.success('Memory added.')
      } else if (factDraft.id) {
        const updated = await api<MemoryRowOut>(`/memories/${factDraft.id}`, {
          method: 'PATCH',
          auth: true,
          body: JSON.stringify({
            kind: factDraft.kind,
            title: factDraft.title,
            body: factDraft.body,
          }),
        })
        setFacts((rows) =>
          (rows ?? []).map((r) => (r.id === updated.id ? updated : r)),
        )
        toast.success('Memory updated.')
      }
      setFactDraft(null)
    } catch (err) {
      toast.error(errorMessage(err, 'Save failed.'))
    } finally {
      setFactSaving(false)
    }
  }

  const dirty = useMemo(() => draft !== savedBody, [draft, savedBody])

  const save = async () => {
    if (!dirty || saving) return
    if (scope === 'project' && !projectId) return
    setSaving(true)
    try {
      const c = await api<CoreOut>('/memories/core', {
        method: 'PUT',
        auth: true,
        body: JSON.stringify({
          scope,
          project_id: scope === 'project' ? projectId : null,
          body: draft,
        }),
      })
      setCore(c)
      setSavedBody(c.body)
      toast.success('Memory saved.')
    } catch (err) {
      toast.error(errorMessage(err, 'Save failed.'))
    } finally {
      setSaving(false)
    }
  }

  const activeProject = projects?.find((p) => p.id === projectId) ?? null

  return (
    <PageScaffold
      active="memory"
      crumbs={['Settings', 'Research', 'Memory']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="RESEARCH"
        title="Memory"
        desc="Long-term context the agent reads before answering. General memory follows you across chats; project memory stays scoped to that project's corpus. Extracted facts can be reviewed, edited, added, or archived."
      />

      <SectionCard
        title="Scope"
        desc="Choose which scope to edit. General is your researcher profile; per-project is scoped to one project's corpus."
      >
        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`ns-btn ${scope === 'general' ? 'primary' : 'ghost'} tiny`}
              onClick={() => {
                setScope('general')
                setProjectId(null)
              }}
            >
              General
            </button>
            <button
              type="button"
              className={`ns-btn ${scope === 'project' ? 'primary' : 'ghost'} tiny`}
              onClick={() => setScope('project')}
              disabled={!projects || projects.length === 0}
              title={
                !projects || projects.length === 0
                  ? 'Create a project first'
                  : undefined
              }
            >
              Project
            </button>
          </div>
          {scope === 'project' && (
            <select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value || null)}
              style={{
                background: 'var(--color-paper-2)',
                border: '1px solid var(--color-rule)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 13,
                color: 'var(--color-ink)',
                maxWidth: 420,
              }}
            >
              <option value="">Select a project…</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={
          scope === 'general'
            ? 'General core memory'
            : activeProject
              ? `Core memory · ${activeProject.name}`
              : 'Project core memory'
        }
        desc={
          scope === 'general'
            ? 'Pinned into every general chat. Use it for things like preferred citation style, prose tone, areas of focus.'
            : 'Pinned into chats inside this project. Use it for what the project is about, the central hypothesis, the corpus you care about.'
        }
      >
        {scope === 'project' && !projectId ? (
          <div
            style={{
              padding: '20px 18px',
              fontSize: 13,
              color: 'var(--color-muted)',
              lineHeight: 1.55,
            }}
          >
            Pick a project above to edit its core memory.
          </div>
        ) : (
          <div
            style={{
              padding: '14px 18px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={loading}
              placeholder={
                scope === 'general'
                  ? "What should the agent always know about you?\n\nExamples:\n- I'm a postdoc in computational neuroscience.\n- I prefer terse Nature-style prose, active voice.\n- Cite in Vancouver style.\n- Bias toward Bayesian methods over frequentist."
                  : "What should the agent always know about this project?\n\nExamples:\n- Working title: 'Sparse coding in V1'.\n- Central claim: orientation-tuned cells emerge from L1 sparsity.\n- Out of scope: V2 / extrastriate areas."
              }
              style={{
                minHeight: 280,
                resize: 'vertical',
                width: '100%',
                padding: 14,
                fontSize: 14,
                lineHeight: 1.55,
                fontFamily: 'var(--font-serif)',
                background: 'var(--color-paper-2)',
                border: '1px solid var(--color-rule)',
                borderRadius: 10,
                color: 'var(--color-ink)',
                outline: 'none',
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--color-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {loading
                  ? 'Loading…'
                  : core?.updated_at
                    ? `Last saved ${new Date(core.updated_at).toLocaleString()}`
                    : 'Not saved yet'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="ns-btn ghost tiny"
                  onClick={() => setDraft(savedBody)}
                  disabled={!dirty || saving}
                >
                  Revert
                </button>
                <button
                  type="button"
                  className="ns-btn primary tiny"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  aria-busy={saving || undefined}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Extracted facts"
        desc="Auto-written after a chat session goes idle (≈10 min). Only high-confidence facts are kept; the table is capped at 200 rows per scope, oldest unused rows archived first."
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="ns-btn ghost tiny"
              onClick={() => setFactsRefreshTick((t) => t + 1)}
              aria-label="Refresh extracted facts"
              title="Refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              className="ns-btn primary tiny"
              onClick={openCreateFact}
              disabled={scope === 'project' && !projectId}
            >
              Add fact
            </button>
          </div>
        }
      >
        {facts === null ? (
          <div
            style={{
              padding: '16px 18px',
              fontSize: 12.5,
              color: 'var(--color-muted)',
            }}
          >
            Loading…
          </div>
        ) : facts.length === 0 ? (
          <div
            style={{
              padding: '20px 18px',
              fontSize: 13,
              color: 'var(--color-muted)',
              lineHeight: 1.55,
            }}
          >
            {scope === 'project' && !projectId
              ? 'Pick a project above to see its extracted facts.'
              : 'No facts saved yet — they appear here automatically after a few chats. You can also tell the agent "remember that …" mid-conversation.'}
          </div>
        ) : (
          <ul
            aria-label="Extracted memory facts"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '6px 0',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {facts.map((f) => (
              <li
                key={f.id}
                style={{
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--color-rule)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    justifyContent: 'space-between',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                    }}
                  >
                    <span
                      className="font-mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        padding: '2px 8px',
                        borderRadius: 999,
                        background:
                          'color-mix(in oklch, var(--color-teal) 12%, transparent)',
                        color: 'var(--color-teal)',
                      }}
                    >
                      {KIND_LABEL[f.kind]}
                    </span>
                    <span
                      style={{
                        fontSize: 13.5,
                        fontWeight: 500,
                        color: 'var(--color-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {f.title}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="ns-btn ghost tiny"
                      onClick={() => openEditFact(f)}
                      aria-label={`Edit ${f.title}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ns-btn ghost tiny"
                      onClick={() => void archive(f.id)}
                      aria-label={`Archive ${f.title}`}
                      title="Archive — hides it from future retrieval. The row stays in the DB."
                    >
                      Archive
                    </button>
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--color-ink-2)',
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  {f.body}
                </p>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 10.5,
                    color: 'var(--color-muted)',
                    display: 'flex',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  {f.source_session ? (
                    <span>Source: session {f.source_session.slice(0, 8)}</span>
                  ) : (
                    <span>Source: manual</span>
                  )}
                  <span>Written {new Date(f.created_at).toLocaleString()}</span>
                  {f.last_recalled_at ? (
                    <span style={{ color: 'var(--color-teal)' }}>
                      Used {new Date(f.last_recalled_at).toLocaleString()}
                    </span>
                  ) : (
                    <span style={{ fontStyle: 'italic' }}>Not used yet</span>
                  )}
                  {f.confidence !== null && Number.isFinite(Number(f.confidence)) ? (
                    <span style={{ color: 'var(--color-ink)' }}>
                      Confidence {Number(f.confidence).toFixed(2)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="How core memory works"
        desc="A small markdown blob the model reads before every reply — durable, fast, no retrieval cost."
      >
        <div
          style={{
            padding: '14px 18px',
            fontSize: 13,
            color: 'var(--color-ink-2)',
            lineHeight: 1.6,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <p style={{ margin: 0 }}>
            Each scope has one core block. Whatever you put here is
            injected as a system message at the top of every chat in
            that scope, ahead of retrieved excerpts. It's the cheapest
            way to make the agent feel like it knows you (or knows the
            project) without burning context on every turn.
          </p>
          <p style={{ margin: 0 }}>
            Keep it tight — a few hundred words at most. For volatile
            facts (open questions, lab notes, paper drafts) lean on
            chat history and per-project materials instead.
          </p>
        </div>
      </SectionCard>
      {factDraft && (
        <Modal
          title={factDraft.mode === 'create' ? 'Add Memory Fact' : 'Edit Memory Fact'}
          description={
            scope === 'project' && activeProject
              ? `Saved to ${activeProject.name}.`
              : 'Saved to your general researcher memory.'
          }
          onClose={() => {
            if (!factSaving) setFactDraft(null)
          }}
          dismissOnOverlayClick={!factSaving}
          dismissOnEscape={!factSaving}
          width={560}
        >
          <form onSubmit={saveFact}>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--color-ink-2)',
                marginBottom: 6,
              }}
            >
              Kind
            </label>
            <select
              value={factDraft.kind}
              onChange={(e) =>
                setFactDraft((cur) =>
                  cur
                    ? {
                        ...cur,
                        kind: e.target.value as MemoryRowOut['kind'],
                      }
                    : cur,
                )
              }
              className="ns-input"
              style={{ width: '100%', marginBottom: 12 }}
            >
              {EDITABLE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>

            <label
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--color-ink-2)',
                marginBottom: 6,
              }}
            >
              Title
            </label>
            <input
              type="text"
              value={factDraft.title}
              onChange={(e) =>
                setFactDraft((cur) =>
                  cur ? { ...cur, title: e.target.value } : cur,
                )
              }
              className="ns-input"
              style={{ width: '100%', marginBottom: 12 }}
              placeholder="Citation style"
            />

            <label
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--color-ink-2)',
                marginBottom: 6,
              }}
            >
              Body
            </label>
            <textarea
              value={factDraft.body}
              onChange={(e) =>
                setFactDraft((cur) =>
                  cur ? { ...cur, body: e.target.value } : cur,
                )
              }
              className="ns-input"
              rows={5}
              style={{
                width: '100%',
                minHeight: 130,
                resize: 'vertical',
                lineHeight: 1.5,
              }}
              placeholder="The user prefers Vancouver-style citations."
            />

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 16,
              }}
            >
              <button
                type="button"
                className="ns-btn ghost"
                onClick={() => setFactDraft(null)}
                disabled={factSaving}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="ns-btn primary"
                disabled={
                  factSaving ||
                  !factDraft.title.trim() ||
                  !factDraft.body.trim()
                }
                aria-busy={factSaving || undefined}
              >
                {factSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </PageScaffold>
  )
}
