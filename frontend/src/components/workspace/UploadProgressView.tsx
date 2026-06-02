/**
 * Full-pane "digesting your sources" view. Takes over the center
 * workspace pane while a fresh upload batch is still being ingested,
 * so the user has a single dedicated spot to watch progress instead of
 * having to spot the per-row strip in the sidebar or the floating pill
 * in the corner.
 *
 * Aggregates ALL in-flight jobs into one prominent progress bar +
 * count ("3 of 7 sources ready"), then breaks down the per-material
 * stage list below it so a stuck job is easy to identify. The
 * "Continue anyway" button is an escape hatch — useful for long
 * documents whose tree-build phase can run several minutes.
 *
 * The host (Workspace.tsx) owns the visibility gate: it sets
 * `uploadInProgress` on every upload, then clears it once all jobs
 * settle (with a short linger so the user sees the "All ready" state).
 */
import { useEffect } from 'react'
import type { IngestionJob, IngestionStage } from './IngestionTracker'
import { Icons } from '../icons'

const STAGE_ORDER: readonly IngestionStage[] = [
  'uploaded',
  'extracting_metadata',
  'renaming',
  'chunking',
  'embedding',
  'extracting_concepts',
  'building_links',
  'ready',
]

const STAGE_LABEL: Record<string, string> = {
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

export function UploadProgressView({
  jobs,
  pendingUploads = 0,
  onContinue,
  autoContinue,
}: {
  jobs: readonly IngestionJob[]
  /** Number of in-flight `/materials/ingest-pdf` (or `-url`) API calls
   *  that have not yet produced a job row. Used to gate the Continue
   *  button: even if every observed job is `ready`, we don't consider
   *  the batch finished while uploads are still being awaited — a fast
   *  first file otherwise looks "all done" for the brief window before
   *  the second file's API call returns. */
  pendingUploads?: number
  /** Called when the user clicks "Continue to workspace" OR when all
   *  jobs reach `ready` and `autoContinue` is true. The host decides
   *  what continuing means (drop this view + navigate). */
  onContinue: () => void
  /** When true and every job is `ready`, fire `onContinue` after a
   *  short delay (so the user sees the "All ready" state). */
  autoContinue?: boolean
}) {
  // Show the SUM of jobs + still-pending uploads as the denominator so
  // the user sees the right "K of N" right from the click. Without
  // this, picking 5 files would render "0 of 0 ready" until the first
  // /ingest-pdf API call returns, then climb (1 of 1, 1 of 2, …) — a
  // confusing display for a known batch size.
  const expectedTotal = jobs.length + pendingUploads
  const total = expectedTotal
  const ready = jobs.filter((j) => j.stage === 'ready').length
  const failed = jobs.filter((j) => j.stage === 'failed').length
  // "All done" requires: at least one job exists, every recorded job
  // is in a terminal state, AND no further uploads are in flight. The
  // pending check is the new gate that prevents the "1 of 1 ready"
  // false positive when a fast first file races ahead of slower
  // siblings still in their upload phase.
  const allDone =
    total > 0 && ready + failed === total && jobs.length > 0 && pendingUploads === 0
  const allReady = allDone && failed === 0

  // Aggregate progress: weight each job by its `progress` (0..1) plus
  // a bonus of 1.0 once it lands on `ready`. Failed jobs are counted
  // as 1.0 too (their slot in the batch is finished, just unsuccessfully)
  // so the bar still completes — the failed count is shown separately.
  const aggregatePct = total === 0 ? 0 : Math.round(
    (jobs.reduce(
      (sum, j) =>
        sum +
        (j.stage === 'ready' || j.stage === 'failed'
          ? 1
          : Math.max(0, Math.min(1, j.progress))),
      0,
    ) /
      total) *
      100,
  )

  // Auto-dismiss when everything's ready. The host's effect-driven
  // clear handles the "all settled (some failed)" case after a longer
  // linger — see Workspace.tsx.
  useEffect(() => {
    if (!autoContinue) return
    if (!allReady) return
    const handle = window.setTimeout(() => {
      onContinue()
    }, 1400)
    return () => window.clearTimeout(handle)
  }, [autoContinue, allReady, onContinue])

  return (
    <div
      className="pane"
      role="region"
      aria-label="Digesting uploaded sources"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        padding: '64px 36px 36px',
        background: '#fff',
      }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.12em',
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
            }}
          >
            Indexing
          </div>
          <h2
            className="font-serif"
            style={{
              fontSize: 26,
              lineHeight: 1.2,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              margin: 0,
              color: 'var(--color-ink)',
            }}
          >
            {allDone
              ? failed > 0
                ? 'Finished — some sources need attention'
                : 'All sources ready'
              : 'Digesting your sources…'}
          </h2>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 14,
              color: 'var(--color-muted)',
              lineHeight: 1.5,
              maxWidth: 520,
            }}
          >
            {allDone
              ? failed > 0
                ? 'Some sources failed to index — review them below, retry, or continue with the ones that succeeded.'
                : 'Everything is indexed and ready to query.'
              : 'notesci is extracting metadata, embedding chunks, finding concepts, and building wiki links so chat answers can cite these sources.'}
          </p>
        </div>

        {/* Aggregate progress: count + percentage + a single bar. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '18px 20px',
            border: '1px solid var(--color-rule)',
            borderRadius: 12,
            background: 'var(--color-paper-2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: 'var(--color-ink)',
                letterSpacing: '-0.01em',
              }}
            >
              {ready} <span style={{ color: 'var(--color-muted)', fontWeight: 400 }}>of {total} ready</span>
            </div>
            {pendingUploads > 0 && (
              <span
                className="font-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-muted)',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {pendingUploads} uploading…
              </span>
            )}
            {failed > 0 && (
              <span
                className="font-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-error)',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {failed} failed
              </span>
            )}
            <span
              className="font-mono"
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: 'var(--color-muted)',
                letterSpacing: '0.04em',
              }}
            >
              {aggregatePct}%
            </span>
          </div>
          <div
            aria-hidden
            style={{
              height: 8,
              borderRadius: 5,
              background: 'var(--color-rule-2)',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                width: `${Math.max(2, aggregatePct)}%`,
                background: allReady
                  ? 'var(--color-teal)'
                  : 'var(--color-indigo)',
                transition: 'width 0.4s ease, background 0.3s ease',
                animation: allDone
                  ? undefined
                  : 'ns-ingestion-pulse 1.6s ease-in-out infinite',
              }}
            />
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--color-muted)',
              lineHeight: 1.45,
            }}
          >
            {allDone
              ? failed > 0
                ? 'Ready to continue — failed sources will not appear in retrieval.'
                : 'Continuing automatically…'
              : 'Please keep this tab open — closing it pauses the pipeline.'}
          </div>
        </div>

        {/* Per-material breakdown. Sorted so failed sit at top (need
            attention), then in-flight, then ready (settled). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.1em',
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Sources ({total})
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...jobs]
              .sort((a, b) => sortKey(a) - sortKey(b))
              .map((job) => (
                <li
                  key={job.materialId}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '12px 14px',
                    border: '1px solid var(--color-rule)',
                    borderRadius: 8,
                    background: '#fff',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 14,
                        height: 14,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color:
                          job.stage === 'failed'
                            ? 'var(--color-error)'
                            : job.stage === 'ready'
                              ? 'var(--color-teal)'
                              : 'var(--color-indigo)',
                      }}
                    >
                      {job.stage === 'failed' ? (
                        <Icons.reset size={12} />
                      ) : job.stage === 'ready' ? (
                        <Icons.starFill size={12} />
                      ) : (
                        <span className="ns-ingestion-spin" />
                      )}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 13,
                        color: 'var(--color-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={job.label}
                    >
                      {job.label}
                    </span>
                    <span
                      className="font-mono"
                      style={{
                        fontSize: 10.5,
                        letterSpacing: '0.04em',
                        color:
                          job.stage === 'failed'
                            ? 'var(--color-error)'
                            : job.stage === 'ready'
                              ? 'var(--color-teal)'
                              : 'var(--color-muted)',
                        textTransform: 'uppercase',
                        flexShrink: 0,
                      }}
                    >
                      {STAGE_LABEL[job.stage] ?? job.stage}
                    </span>
                  </div>
                  {/* Per-source stage chips. Mirror the strip we use in
                      the floating pill so a glance shows the pipeline
                      position even across many sources. */}
                  <div
                    aria-hidden
                    style={{ display: 'flex', gap: 2 }}
                  >
                    {STAGE_ORDER.map((s, i) => {
                      const stepIdx = STAGE_ORDER.indexOf(
                        job.stage === 'failed'
                          ? 'building_links'
                          : (job.stage as IngestionStage),
                      )
                      const failed = job.stage === 'failed'
                      const ready = job.stage === 'ready'
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
                            opacity: isCurrent ? undefined : passed || failed ? 1 : 0.5,
                            animation: isCurrent
                              ? 'ns-ingestion-pulse 1.2s ease-in-out infinite'
                              : undefined,
                          }}
                        />
                      )
                    })}
                  </div>
                  {job.stage === 'failed' && job.errorMsg && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--color-error)',
                        lineHeight: 1.45,
                      }}
                    >
                      {job.errorMsg}
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </div>

        {/* The Continue button only appears once every job in the
            batch is in a terminal state (ready / failed). Until then
            we deliberately don't expose an "early exit" — users found
            that leaving mid-batch and seeing partial retrieval was
            more confusing than the brief wait. The same intent drives
            the host's lack of `autoContinue`: dismissal is always an
            explicit click. */}
        {allDone ? (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginTop: 4,
            }}
          >
            <button
              type="button"
              className="ns-btn"
              onClick={onContinue}
              style={{
                padding: '8px 16px',
                fontSize: 13,
              }}
              autoFocus
            >
              Continue to workspace
            </button>
            {failed > 0 && (
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--color-muted)',
                }}
              >
                Sources that failed will not appear in retrieval.
              </span>
            )}
          </div>
        ) : (
          <div
            style={{
              fontSize: 12,
              color: 'var(--color-muted)',
              fontStyle: 'italic',
            }}
          >
            Waiting for every source to finish indexing before continuing.
          </div>
        )}
      </div>
    </div>
  )
}

function sortKey(j: IngestionJob): number {
  // Failed first (need attention), then in-flight, then ready.
  if (j.stage === 'failed') return 0
  if (j.stage === 'ready') return 2
  return 1
}
