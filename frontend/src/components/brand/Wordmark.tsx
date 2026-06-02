/**
 * notesci wordmark — three weight treatments per the locked identity.
 * - split (default): note (weight 600) + sci (weight 500, muted color)
 * - accent: both 500, sci colored teal
 * - uniform: weight 600 single ink color
 *
 * Letter-spacing -0.03em, line-height 1, lowercase always.
 */
export function Wordmark({
  variant = 'split',
  size = 44,
}: {
  variant?: 'split' | 'accent' | 'uniform'
  size?: number
}) {
  const base: React.CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: size,
    letterSpacing: '-0.03em',
    lineHeight: 1,
    color: 'var(--color-ink)',
    display: 'inline-flex',
    alignItems: 'baseline',
  }
  if (variant === 'split') {
    return (
      <span style={base}>
        <span style={{ fontWeight: 600 }}>note</span>
        <span style={{ fontWeight: 500, color: 'var(--color-muted)' }}>sci</span>
      </span>
    )
  }
  if (variant === 'accent') {
    return (
      <span style={base}>
        <span style={{ fontWeight: 500 }}>note</span>
        <span style={{ fontWeight: 500, color: 'var(--color-teal)' }}>sci</span>
      </span>
    )
  }
  return <span style={{ ...base, fontWeight: 600 }}>notesci</span>
}
