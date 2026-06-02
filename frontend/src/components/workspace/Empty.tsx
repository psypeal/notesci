import type { ReactNode } from 'react'

/**
 * Centered "first-run" card used by the design's three empty states
 * (no projects, no materials in project, no session yet). Mirrors
 * `EmptyCard` from `ws-empty.jsx`.
 */
export function EmptyCard({
  kind,
  title,
  desc,
  primary,
  secondary,
  illus,
}: {
  kind: string
  title: ReactNode
  desc: ReactNode
  primary?: { label: string; onClick?: () => void; disabled?: boolean; busy?: boolean }
  secondary?: { label: string; onClick?: () => void; disabled?: boolean }
  illus?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '60px 40px',
        maxWidth: 520,
        margin: 'auto',
        color: 'var(--color-ink-2)',
      }}
    >
      <div style={{ marginBottom: 18, color: 'var(--color-muted)' }}>{illus}</div>
      <div
        className="font-mono"
        title={kind}
        style={{
          fontSize: 10.5,
          letterSpacing: '0.12em',
          color: 'var(--color-muted)',
          marginBottom: 8,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {kind}
      </div>
      <h2
        className="font-serif"
        style={{
          fontSize: 26,
          lineHeight: 1.2,
          fontWeight: 500,
          color: 'var(--color-ink)',
          margin: 0,
          marginBottom: 10,
        }}
      >
        {title}
      </h2>
      <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 22 }}>{desc}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {primary && (
          <button
            type="button"
            className="ns-btn"
            onClick={primary.onClick}
            disabled={primary.disabled || primary.busy}
            aria-busy={primary.busy ? true : undefined}
          >
            {primary.label}
          </button>
        )}
        {secondary && (
          <button
            type="button"
            className="ns-btn ghost"
            onClick={secondary.onClick}
            disabled={secondary.disabled}
          >
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  )
}

export function ProjectsIllus() {
  return (
    <svg
      width="120"
      height="80"
      viewBox="0 0 120 80"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <circle cx={30} cy={40} r={14} />
      <circle cx={60} cy={22} r={9} />
      <circle cx={90} cy={40} r={14} />
      <circle cx={60} cy={58} r={9} />
      <path
        d="m40 38 14-12M70 26l12 8M82 50 70 56M40 44l14 12"
        stroke="var(--color-rule-2)"
      />
    </svg>
  )
}

export function MaterialsIllus() {
  return (
    <svg
      width="120"
      height="80"
      viewBox="0 0 120 80"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x={8} y={20} width={34} height={46} rx={3} />
      <rect x={44} y={14} width={34} height={52} rx={3} />
      <rect x={80} y={22} width={34} height={44} rx={3} />
      <path d="M52 30h18M52 38h14M52 46h18" stroke="var(--color-rule-2)" />
    </svg>
  )
}

export function SessionIllus() {
  return (
    <svg
      width="80"
      height="80"
      viewBox="0 0 80 80"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <circle cx={40} cy={40} r={22} />
      <path d="M30 38c2-6 12-7 14 0c1 5-6 5-6 10M40 56v.01" />
    </svg>
  )
}
