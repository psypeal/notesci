/**
 * Auth-provider buttons — Google, GitHub, ORCID, Institution.
 * Inline SVGs lifted from the design handoff's `signin.jsx` ICON map.
 *
 * The backend doesn't yet wire up SSO; for now these are visual-only
 * (clicking shows a "not yet" toast). The design's intent is preserved
 * so the layout reads correctly.
 */
const Google = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
    <path
      fill="#4285f4"
      d="M22.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.22-4.74 3.22-8.11z"
    />
    <path
      fill="#34a853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#fbbc04"
      d="M5.84 14.1A6.97 6.97 0 0 1 5.45 12c0-.73.13-1.43.36-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.66-2.84z"
    />
    <path
      fill="#ea4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
    />
  </svg>
)

const Github = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.65 3 8.6 7.18 9.99.52.1.71-.23.71-.5v-1.7c-2.92.63-3.54-1.4-3.54-1.4-.48-1.21-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.05.07 1.6 1.08 1.6 1.08.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.67-1.4-2.33-.27-4.78-1.17-4.78-5.2 0-1.15.41-2.08 1.08-2.82-.1-.27-.47-1.34.1-2.78 0 0 .88-.28 2.88 1.08A10 10 0 0 1 12 6.84c.89 0 1.78.12 2.62.35 2-1.36 2.88-1.08 2.88-1.08.57 1.44.21 2.51.1 2.78.67.74 1.08 1.67 1.08 2.82 0 4.04-2.46 4.93-4.8 5.19.38.32.71.96.71 1.95v2.88c0 .28.19.6.71.5A10.5 10.5 0 0 0 22.5 12C22.5 6.2 17.8 1.5 12 1.5z" />
  </svg>
)

const Orcid = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="11" fill="#a6ce39" />
    <text
      x="12"
      y="16"
      textAnchor="middle"
      fontSize="11"
      fontWeight="700"
      fill="#fff"
      fontFamily="Inter Tight, sans-serif"
    >
      iD
    </text>
  </svg>
)

const Institution = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 3 2 8.5 12 14l10-5.5L12 3z" />
    <path d="M6 11v5c0 1 2.5 3 6 3s6-2 6-3v-5" />
  </svg>
)

const PROVIDERS = [
  { id: 'google', icon: <Google />, label: 'Google' },
  { id: 'github', icon: <Github />, label: 'GitHub' },
  { id: 'orcid', icon: <Orcid />, label: 'ORCID' },
  { id: 'inst', icon: <Institution />, label: 'Institution' },
] as const

export function SocialButtons({
  onClick,
}: {
  onClick?: (provider: 'google' | 'github' | 'orcid' | 'inst') => void
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {PROVIDERS.map((p) => (
        <button
          key={p.id}
          type="button"
          className="ns-btn ghost"
          style={{ background: '#fff' }}
          onClick={() => onClick?.(p.id)}
        >
          {p.icon}
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  )
}
