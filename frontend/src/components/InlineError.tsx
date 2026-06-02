import type { ReactNode } from 'react'

/**
 * Inline error treatments mirroring `states.jsx` from the handoff:
 *
 * - `<TopFormError>` — bold red-bordered alert at the top of a form,
 *   with an 18px circle "!" badge. Used for non-field-specific errors
 *   (wrong password, etc.) per the design's sign-in error state.
 * - `<FieldError>` — small inline message under a field with a 14px
 *   circle "!" badge. Used by the design's invalid-code and
 *   email-already-in-use states.
 */
export function TopFormError({
  title,
  body,
}: {
  title: ReactNode
  body?: ReactNode
}) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 14px',
        background: 'color-mix(in oklch, var(--color-error) 8%, white)',
        border: '1px solid color-mix(in oklch, var(--color-error) 35%, transparent)',
        borderRadius: 10,
        alignItems: 'flex-start',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          width: 18,
          height: 18,
          borderRadius: 9,
          background: 'var(--color-error)',
          color: 'white',
          fontSize: 11,
          fontWeight: 700,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        !
      </span>
      <div
        style={{
          fontSize: 13,
          color: 'oklch(0.42 0.18 25)',
          lineHeight: 1.45,
        }}
      >
        <strong>{title}</strong>
        {body && (
          <>
            <br />
            {body}
          </>
        )}
      </div>
    </div>
  )
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <span
      role="alert"
      style={{
        fontSize: 11.5,
        color: 'var(--color-error)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          width: 14,
          height: 14,
          borderRadius: 7,
          background: 'var(--color-error)',
          color: 'white',
          fontSize: 10,
          fontWeight: 700,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        !
      </span>
      {children}
    </span>
  )
}
