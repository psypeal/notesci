import type { ReactNode } from 'react'
import { Lockup } from './brand/Lockup'

/**
 * V1 "Editorial" two-column layout used by sign-in, claim, waitlist,
 * forgot-password, set-new-password, invite-link landing.
 *
 * Mirrors the design handoff's `FormColumn` / `Hero` composition: form
 * on the left with Lockup top + footer bottom, hero on the right.
 */
export function AuthLayout({
  children,
  hero,
}: {
  children: ReactNode
  hero?: ReactNode
}) {
  return (
    <div
      className="grid lg:grid-cols-2"
      style={{ background: 'var(--color-paper)', minHeight: '100vh' }}
    >
      <FormColumn>{children}</FormColumn>
      {hero ? hero : null}
    </div>
  )
}

/**
 * Left column. Lockup at top, form vertically-centered, footer at
 * bottom. The form is wrapped in an inner box (max 380px wide) inside
 * a flex-grow `<main>` that vertically centers it — symmetric with
 * the right-side hero's top/middle/bottom rhythm regardless of how
 * tall the viewport gets. Handoff padding: 56px 72px desktop, 32px 28px mobile.
 */
export function FormColumn({ children }: { children: ReactNode }) {
  return (
    <div className="form-column">
      <header className="form-column-header">
        <Lockup variant="split" size={20} />
      </header>
      <div className="form-column-spacer" aria-hidden />
      <main id="main" className="form-column-main">
        {children}
      </main>
      <div className="form-column-spacer" aria-hidden />
      <Footer />
    </div>
  )
}

/**
 * Single-column variant for status frames (reset-sent, verify-email,
 * already-claimed, expired-invite). Lockup top, centered content,
 * footer at bottom.
 */
export function StatusLayout({
  kind = 'info',
  eyebrow,
  headline,
  body,
  primary,
  secondary,
  icon,
}: {
  kind?: 'info' | 'success' | 'warn' | 'error'
  eyebrow: string
  headline: ReactNode
  body: ReactNode
  primary?: { label: string; onClick?: () => void; href?: string; busy?: boolean; disabled?: boolean }
  secondary?: { label: string; onClick?: () => void; href?: string; disabled?: boolean }
  icon?: ReactNode
}) {
  const accent =
    kind === 'success'
      ? 'var(--color-teal)'
      : kind === 'warn'
        ? 'var(--color-warn)'
        : kind === 'error'
          ? 'var(--color-error)'
          : 'var(--color-indigo)'
  const glyph =
    kind === 'success' ? '✓' : kind === 'warn' ? '!' : kind === 'error' ? '×' : '✉'
  return (
    <div
      style={{
        background: 'var(--color-paper)',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        padding: '40px 56px',
      }}
      className="max-lg:p-8"
    >
      <header>
        <Lockup variant="split" size={20} />
      </header>
      <main
        id="main"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
          }}
        >
          {icon ?? (
            <div
              aria-hidden
              className="status-icon"
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                background: `color-mix(in oklch, ${accent} 18%, transparent)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: accent,
                fontSize: 32,
              }}
            >
              {glyph}
            </div>
          )}
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.1em',
              color: 'var(--color-muted)',
            }}
          >
            {eyebrow}
          </div>
          <h1
            className="font-serif editorial-h1"
            style={{
              fontSize: 42,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: 0,
              fontWeight: 500,
            }}
          >
            {headline}
          </h1>
          <p
            style={{
              fontSize: 15,
              color: '#3a342c',
              margin: 0,
              lineHeight: 1.55,
              maxWidth: 440,
            }}
          >
            {body}
          </p>
          {(primary || secondary) && (
            <div
              className="status-actions"
              style={{ display: 'flex', gap: 10, marginTop: 12 }}
            >
              {primary && (
                <ActionButton variant="primary" {...primary} />
              )}
              {secondary && (
                <ActionButton variant="ghost" {...secondary} />
              )}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}

function ActionButton({
  variant,
  label,
  onClick,
  href,
  busy,
  disabled,
}: {
  variant: 'primary' | 'ghost'
  label: string
  onClick?: () => void
  href?: string
  busy?: boolean
  disabled?: boolean
}) {
  const cls = variant === 'primary' ? 'ns-btn' : 'ns-btn ghost'
  if (href) {
    return (
      <a className={cls} href={href}>
        {label}
      </a>
    )
  }
  return (
    <button
      className={cls}
      onClick={onClick}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
    >
      {label}
    </button>
  )
}

export function Footer() {
  return (
    <footer
      className="font-mono"
      style={{
        fontSize: 10.5,
        color: 'var(--color-muted)',
        letterSpacing: '0.06em',
        display: 'flex',
        gap: 18,
        marginTop: 24,
      }}
    >
      <span>© 2026 notesci</span>
      <span>privacy</span>
      <span>terms</span>
    </footer>
  )
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div
      className="font-mono"
      style={{
        fontSize: 11,
        letterSpacing: '0.1em',
        color: 'var(--color-muted)',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  )
}

export function PageH1({ children }: { children: ReactNode }) {
  return (
    <h1
      className="font-serif editorial-h1"
      style={{
        fontSize: 38,
        lineHeight: 1.1,
        letterSpacing: '-0.02em',
        margin: 0,
        fontWeight: 500,
      }}
    >
      {children}
    </h1>
  )
}

export function PageSub({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 14,
        color: 'var(--color-muted)',
        margin: '10px 0 0',
        lineHeight: 1.55,
      }}
    >
      {children}
    </p>
  )
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--color-error)',
        color: 'var(--color-error)',
        background:
          'color-mix(in oklch, var(--color-error) 8%, transparent)',
      }}
    >
      {children}
    </div>
  )
}
