/**
 * notesci NS lettermark — pure port of the design handoff's `mark.jsx`.
 * Geometry: 96×96 viewBox, 8px round strokes, hub at (52,60).
 *
 * Don't restyle — this matches the locked identity. Pass colorN/colorS
 * to switch pairings; rounded=true wraps in the dark app-tile variant.
 */
export function Mark({
  size = 96,
  colorN = 'var(--color-indigo)',
  colorS = 'var(--color-teal)',
  hub = 'var(--color-ink)',
  rounded = false,
  tileColor = 'var(--color-ink)',
  tileFg = 'white',
}: {
  size?: number
  colorN?: string
  colorS?: string
  hub?: string
  rounded?: boolean
  tileColor?: string
  tileFg?: string
}) {
  const cN = rounded ? tileFg : colorN
  const cS = rounded ? 'oklch(0.78 0.18 195)' : colorS
  const cH = rounded ? 'oklch(0.78 0.18 130)' : hub

  const inner = (
    <g>
      <g fill="none" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 22 L22 70" stroke={cN} />
        <path d="M22 22 L52 60" stroke={cN} />
      </g>
      <path
        d="M76 30 C 76 20, 58 20, 58 32 C 58 42, 74 44, 74 54 C 74 66, 56 66, 52 60"
        fill="none"
        stroke={cS}
        strokeWidth={8}
        strokeLinecap="round"
      />
      <g fill={rounded ? tileColor : 'var(--color-paper)'} strokeWidth={3}>
        <circle cx="22" cy="22" r="5" stroke={cN} />
        <circle cx="22" cy="70" r="5" stroke={cN} />
        <circle cx="76" cy="30" r="5" stroke={cS} />
      </g>
      <circle cx="52" cy="60" r="6.5" fill={cH} />
    </g>
  )

  if (rounded) {
    return (
      <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden>
        <rect x={2} y={2} width={92} height={92} rx={22} fill={tileColor} />
        {inner}
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden>
      {inner}
    </svg>
  )
}
