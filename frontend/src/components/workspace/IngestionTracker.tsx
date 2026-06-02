/**
 * Tracks active ingestion-pipeline jobs and renders a floating progress
 * strip that animates the stage chips while metadata extraction, slug
 * rename, concept extraction, and wiki-link building run in the
 * background.
 *
 * Usage:
 *   const tracker = useIngestionTracker({ onComplete })
 *   // when an upload starts:
 *   tracker.startJob({ materialId, jobId, label })
 *   // render somewhere stable in the workspace:
 *   <IngestionStrip jobs={tracker.jobs} onDismiss={tracker.dismissJob} />
 *
 * The hook polls /materials/{id}/ingestion-status every ~1.4s while
 * jobs are active and drops a job from state once the pipeline reaches
 * 'ready' or 'failed' (after a short lingering window so the success
 * pulse animation has time to play).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { Icons } from '../icons'

export type IngestionStage =
  | 'uploaded'
  | 'extracting_metadata'
  | 'renaming'
  | 'chunking'
  | 'embedding'
  | 'extracting_concepts'
  | 'building_links'
  | 'ready'
  | 'failed'

const STAGE_ORDER: IngestionStage[] = [
  'uploaded',
  'extracting_metadata',
  'renaming',
  'chunking',
  'embedding',
  'extracting_concepts',
  'building_links',
  'ready',
]

const STAGE_LABEL: Record<IngestionStage, string> = {
  uploaded: 'Uploaded',
  extracting_metadata: 'Reading metadata',
  renaming: 'Renaming',
  chunking: 'Chunking',
  embedding: 'Embedding',
  extracting_concepts: 'Extracting concepts',
  building_links: 'Building wiki links',
  ready: 'Ready',
  failed: 'Failed',
}

const POLL_MS = 1400
const LINGER_AFTER_READY_MS = 1800

export interface IngestionJob {
  materialId: string
  jobId: string | null
  label: string
  stage: IngestionStage
  progress: number
  note: string | null
  errorMsg: string | null
  startedAt: number
}

interface StatusResponse {
  job_id: string
  material_id: string
  stage: IngestionStage
  progress: number
  note: string | null
  error_code: string | null
  error_msg: string | null
  updated_at: string
}

export function useIngestionTracker({
  onComplete,
}: {
  /** Fires when a job lands on `ready` — workspace uses it to refresh
   *  the materials list so the renamed title surfaces. */
  onComplete?: (materialId: string) => void
} = {}) {
  const [jobs, setJobs] = useState<IngestionJob[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const startJob = useCallback(
    (input: { materialId: string; jobId: string | null; label: string }) => {
      setJobs((cur) => {
        if (cur.some((j) => j.materialId === input.materialId)) return cur
        return [
          ...cur,
          {
            materialId: input.materialId,
            jobId: input.jobId,
            label: input.label,
            stage: 'uploaded',
            progress: 0,
            note: null,
            errorMsg: null,
            startedAt: Date.now(),
          },
        ]
      })
    },
    [],
  )

  const dismissJob = useCallback((materialId: string) => {
    const t = timersRef.current.get(materialId)
    if (t) {
      window.clearTimeout(t)
      timersRef.current.delete(materialId)
    }
    setJobs((cur) => cur.filter((j) => j.materialId !== materialId))
  }, [])

  // One long-running poll that walks every active job and updates its
  // state. Stops automatically when the list is empty.
  useEffect(() => {
    const activeIds = jobs
      .filter((j) => j.stage !== 'ready' && j.stage !== 'failed')
      .map((j) => j.materialId)
    if (activeIds.length === 0) return

    let cancelled = false
    const tick = async () => {
      const results = await Promise.allSettled(
        activeIds.map(async (id) => {
          const r = await api<StatusResponse>(
            `/materials/${id}/ingestion-status`,
            { auth: true },
          )
          return { id, status: r }
        }),
      )
      if (cancelled) return
      setJobs((cur) =>
        cur.map((job) => {
          const found = results.find(
            (r) => r.status === 'fulfilled' && r.value.id === job.materialId,
          )
          if (!found || found.status !== 'fulfilled') return job
          const s = found.value.status
          return {
            ...job,
            stage: s.stage,
            progress: s.progress,
            note: s.note,
            errorMsg: s.error_msg,
          }
        }),
      )
    }
    const handle = window.setInterval(() => {
      void tick()
    }, POLL_MS)
    // Fire one immediately so the user sees the first transition fast.
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [jobs])

  // After a job hits 'ready', schedule its removal so the green-tick
  // animation gets a beat to settle. 'failed' lingers longer so the
  // user can read the error.
  useEffect(() => {
    for (const job of jobs) {
      if (job.stage !== 'ready' && job.stage !== 'failed') continue
      if (timersRef.current.has(job.materialId)) continue
      const wait = job.stage === 'failed' ? 7000 : LINGER_AFTER_READY_MS
      const handle = window.setTimeout(() => {
        timersRef.current.delete(job.materialId)
        dismissJob(job.materialId)
      }, wait)
      timersRef.current.set(job.materialId, handle)
      if (job.stage === 'ready') {
        onCompleteRef.current?.(job.materialId)
      }
    }
  }, [jobs, dismissJob])

  // Tear down pending timers on unmount.
  useEffect(() => {
    return () => {
      for (const handle of timersRef.current.values()) {
        window.clearTimeout(handle)
      }
      timersRef.current.clear()
    }
  }, [])

  const activeIds = useMemo(
    () => new Set(jobs.filter((j) => j.stage !== 'failed').map((j) => j.materialId)),
    [jobs],
  )

  // Per-material job lookup. The SidePanel reads this to render an
  // inline progress bar on each material row; map shape (vs. the
  // jobs array) lets a row do an O(1) lookup without scanning.
  const jobsById = useMemo(() => {
    const m = new Map<string, IngestionJob>()
    for (const j of jobs) m.set(j.materialId, j)
    return m
  }, [jobs])

  return { jobs, startJob, dismissJob, activeIds, jobsById }
}


export function IngestionStrip({
  jobs,
  onDismiss,
}: {
  jobs: IngestionJob[]
  onDismiss: (materialId: string) => void
}) {
  if (jobs.length === 0) return null
  return (
    <div
      role="region"
      aria-label="Ingestion progress"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 40,
        maxWidth: 380,
      }}
    >
      {jobs.map((j) => (
        <IngestionPill key={j.materialId} job={j} onDismiss={onDismiss} />
      ))}
    </div>
  )
}


function IngestionPill({
  job,
  onDismiss,
}: {
  job: IngestionJob
  onDismiss: (materialId: string) => void
}) {
  const failed = job.stage === 'failed'
  const ready = job.stage === 'ready'
  const stepIdx = STAGE_ORDER.indexOf(
    failed ? 'building_links' : (job.stage as Exclude<IngestionStage, 'failed'>),
  )
  const label = STAGE_LABEL[job.stage] ?? 'Working'

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        'ns-ingestion-pill' +
        (ready ? ' is-ready' : '') +
        (failed ? ' is-failed' : '')
      }
      style={{
        background: '#fff',
        border: '1px solid var(--color-rule)',
        borderRadius: 12,
        padding: '12px 14px',
        boxShadow: '0 16px 32px -8px rgba(14,17,22,0.12)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: failed
              ? 'var(--color-error)'
              : ready
                ? 'var(--color-teal)'
                : 'var(--color-indigo)',
          }}
        >
          {failed ? (
            <Icons.reset size={14} />
          ) : ready ? (
            <Icons.starFill size={14} />
          ) : (
            <span className="ns-ingestion-spin" />
          )}
        </span>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            color: 'var(--color-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 500,
          }}
          title={job.label}
        >
          {job.label}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(job.materialId)}
          className="ns-btn ghost tiny"
          style={{ padding: '2px 6px', fontSize: 11 }}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--color-muted)',
          fontFamily:
            'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
          letterSpacing: '0.04em',
        }}
      >
        <span
          style={{
            color: failed
              ? 'var(--color-error)'
              : ready
                ? 'var(--color-teal)'
                : 'var(--color-indigo)',
          }}
        >
          {failed ? 'FAILED' : ready ? 'DONE' : label.toUpperCase()}
        </span>
        {job.note && !failed && (
          <span aria-hidden style={{ color: 'var(--color-muted-2)' }}>
            · {job.note}
          </span>
        )}
      </div>
      <div
        aria-hidden
        style={{
          display: 'flex',
          gap: 3,
          marginTop: 2,
        }}
      >
        {STAGE_ORDER.map((s, i) => {
          const passed = i <= stepIdx && !failed
          const isCurrent = i === stepIdx && !ready && !failed
          return (
            <span
              key={s}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: failed
                  ? i <= stepIdx
                    ? 'var(--color-error)'
                    : 'var(--color-rule-2)'
                  : passed
                    ? 'var(--color-indigo)'
                    : 'var(--color-rule-2)',
                opacity: isCurrent ? undefined : passed || failed ? 1 : 0.6,
                animation: isCurrent ? 'ns-ingestion-pulse 1.2s ease-in-out infinite' : undefined,
              }}
            />
          )
        })}
      </div>
      {failed && job.errorMsg && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--color-error)',
            lineHeight: 1.45,
          }}
        >
          {job.errorMsg}
        </div>
      )}
    </div>
  )
}
