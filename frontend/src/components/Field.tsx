import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

/**
 * Brand-styled labelled field. Mirrors the `Field` atom in the design
 * handoff's `signin.jsx` exactly: monospace eyebrow label (10.5px,
 * 0.1em letter-spacing, uppercase, muted), optional right-aligned
 * `action` (e.g. "Forgot?"), optional `hint` below the input.
 */
export function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <span
          className="font-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: '0.1em',
            color: 'var(--color-muted)',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        {action ? <span style={{ fontSize: 11.5 }}>{action}</span> : null}
      </span>
      {children}
      {hint ? (
        <span style={{ fontSize: 11.5, color: 'var(--color-muted)' }}>{hint}</span>
      ) : null}
    </label>
  )
}

export function NsInput(
  props: InputHTMLAttributes<HTMLInputElement> & { error?: boolean; mono?: boolean }
) {
  const { error, mono, className = '', ...rest } = props
  return (
    <input
      {...rest}
      aria-invalid={error || undefined}
      className={[
        'ns-input',
        mono ? 'mono' : '',
        error ? 'error' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
}

export function NsTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }
) {
  const { error, className = '', ...rest } = props
  return (
    <textarea
      {...rest}
      aria-invalid={error || undefined}
      className={['ns-input', error ? 'error' : '', className]
        .filter(Boolean)
        .join(' ')}
      style={{ resize: 'vertical', fontFamily: 'inherit', ...(rest.style ?? {}) }}
    />
  )
}
