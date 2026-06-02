import { Mark } from './brand/Mark'

/**
 * Editorial right-panel "hero". Three treatments per the design handoff:
 * - headline (default): big serif h2, last 3 words italic + indigo,
 *   stats row at bottom (1.4M papers, 340 researchers, v0.3 beta)
 * - pullquote: oversized "“", italic quote, attributed to Dr. Sara Kostas
 * - mark: just the giant mark, centered
 *
 * Always paper-2 background with the 14px-grid radial-dot pattern at 7%
 * opacity, and a left rule. Top-right "VOL. 01 · ISSUE 03 · EARLY ACCESS"
 * eyebrow toggleable via showIssue.
 */
export function Hero({
  treatment = 'headline',
  headline = 'Read, query, and draft from a single source of truth.',
  showStats = true,
  showIssue = true,
}: {
  treatment?: 'headline' | 'pullquote' | 'mark'
  headline?: string
  showStats?: boolean
  showIssue?: boolean
}) {
  return (
    <aside
      // Editorial hero on the right side of the auth shell — purely
      // decorative/marketing context, not part of the form flow.
      // `aria-label` distinguishes it from any other complementary
      // region on the page.
      aria-label="About notesci"
      className="hidden lg:flex flex-col justify-between relative overflow-hidden"
      style={{
        background: 'var(--color-paper-2)',
        padding: 56,
        borderLeft: '1px solid var(--color-rule)',
        height: '100%',
      }}
    >
      {/* dot pattern overlay */}
      <svg
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0.07,
          pointerEvents: 'none',
        }}
      >
        <defs>
          <pattern
            id="hero-dots"
            width={14}
            height={14}
            patternUnits="userSpaceOnUse"
          >
            <circle cx={1} cy={1} r={1} fill="var(--color-ink)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-dots)" />
      </svg>

      {/* Issue eyebrow */}
      <div
        className="font-mono relative"
        style={{
          fontSize: 11,
          letterSpacing: '0.12em',
          color: 'var(--color-muted)',
          visibility: showIssue ? 'visible' : 'hidden',
        }}
      >
        VOL. 01 · ISSUE 03 · EARLY ACCESS
      </div>

      {/* Body */}
      <div className="relative" style={{ maxWidth: 480 }}>
        {treatment === 'headline' && (
          <>
            <div style={{ marginBottom: 24 }}>
              <Mark size={64} />
            </div>
            <HeadlineTitle headline={headline} />
            <p
              style={{
                fontSize: 16,
                lineHeight: 1.55,
                color: '#3a342c',
                margin: '24px 0 0',
                maxWidth: 420,
              }}
            >
              Build a personal corpus of papers, run queries that respect
              provenance, and draft directly against your annotations.
            </p>
          </>
        )}
        {treatment === 'pullquote' && (
          <>
            <div
              style={{
                fontSize: 80,
                lineHeight: 0.5,
                color: 'var(--color-indigo)',
                fontFamily: 'var(--font-serif)',
              }}
            >
              “
            </div>
            <h2
              className="font-serif"
              style={{
                fontSize: 36,
                lineHeight: 1.2,
                letterSpacing: '-0.015em',
                margin: '16px 0 0',
                fontWeight: 500,
                fontStyle: 'italic',
              }}
            >
              The closest thing to having a research assistant who actually read
              every paper in my library.
            </h2>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 32,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  background: 'var(--color-indigo)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                SK
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>Dr. Sara Kostas</div>
                <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                  Computational Biology · Stanford
                </div>
              </div>
            </div>
          </>
        )}
        {treatment === 'mark' && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: 360,
            }}
          >
            <Mark size={260} />
          </div>
        )}
      </div>

      {/* Stats row */}
      {showStats ? (
        <div
          className="relative"
          style={{
            display: 'flex',
            gap: 32,
            fontSize: 12,
            color: 'var(--color-muted)',
          }}
        >
          {[
            { big: '1.4M', label: 'indexed papers' },
            { big: '340', label: 'early researchers' },
            { big: 'v0.3', label: 'private beta' },
          ].map((s) => (
            <div key={s.label}>
              <div
                style={{
                  fontSize: 22,
                  color: 'var(--color-ink)',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                }}
              >
                {s.big}
              </div>
              <div className="font-mono" style={{ letterSpacing: '0.06em' }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div />
      )}
    </aside>
  )
}

function HeadlineTitle({ headline }: { headline: string }) {
  // Per the handoff: last 3 words go in <em> with indigo accent.
  const words = headline.split(' ')
  const lead = words.slice(0, -3).join(' ')
  const tail = words.slice(-3).join(' ')
  return (
    <h2
      className="font-serif"
      style={{
        fontSize: 54,
        lineHeight: 1.05,
        letterSpacing: '-0.025em',
        margin: 0,
        fontWeight: 500,
      }}
    >
      {lead}{' '}
      <em style={{ color: 'var(--color-indigo)', fontStyle: 'italic' }}>
        {tail}
      </em>
    </h2>
  )
}
