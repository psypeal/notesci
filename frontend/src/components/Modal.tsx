import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'

/**
 * Generic dialog. Mirrors the editorial language: paper background, ink
 * border, indigo primary CTA, ghost cancel. Closes on Esc and overlay
 * click. Mount conditionally — `open` is implicit via mount/unmount, so
 * callers control visibility by rendering or not.
 */
export function Modal({
  title,
  description,
  children,
  onClose,
  width = 460,
  dismissOnOverlayClick = true,
  dismissOnEscape = true,
  chromeless = false,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  onClose: () => void
  width?: number
  /** When false, clicks on the dimmed overlay don't close the modal —
   *  use this for forms where stray clicks would lose typed input. */
  dismissOnOverlayClick?: boolean
  /** When false, Esc doesn't close the modal. Use for one-time-reveal
   *  dialogs (e.g. just-created PAT) where stray keystrokes mustn't
   *  drop a value the user can never see again. */
  dismissOnEscape?: boolean
  /** When true, the title/description header and content padding are
   *  dropped so ``children`` fill the dialog edge-to-edge. Used for the
   *  full-bleed live source preview. ``title`` is still used for a11y. */
  chromeless?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descId = useId()
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dismissOnEscape) onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    // If nothing inside the dialog has focus yet (e.g. ConfirmModal),
    // pull focus to the first focusable element so Tab + Enter work.
    queueMicrotask(() => {
      if (!dialogRef.current) return
      if (dialogRef.current.contains(document.activeElement)) return
      const first = dialogRef.current.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      first?.focus()
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      previouslyFocused?.focus?.()
    }
  }, [onClose, dismissOnEscape])
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (!dismissOnOverlayClick) return
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14,17,22,0.32)',
        zIndex: 150,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        style={{
          width,
          maxWidth: '100%',
          background: 'var(--color-paper)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(0,0,0,0.20)',
          border: '1px solid var(--color-rule)',
          overflow: 'hidden',
        }}
      >
        {chromeless ? (
          children
        ) : (
          <>
            <div style={{ padding: '20px 24px 8px' }}>
              <h2
                id={titleId}
                style={{
                  fontFamily: 'var(--font-serif), Georgia, serif',
                  fontSize: 22,
                  lineHeight: 1.2,
                  margin: 0,
                  letterSpacing: '-0.01em',
                }}
              >
                {title}
              </h2>
              {description && (
                <p
                  id={descId}
                  style={{
                    fontSize: 13.5,
                    color: 'var(--color-ink-2)',
                    marginTop: 6,
                    marginBottom: 0,
                  }}
                >
                  {description}
                </p>
              )}
            </div>
            <div style={{ padding: '14px 24px 22px' }}>{children}</div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Single-field text prompt replacement. Used for "Name your new project",
 * "Highlight passage", etc.
 */
export function TextPromptModal({
  title,
  description,
  label,
  placeholder,
  initial = '',
  multiline = false,
  submitLabel = 'Save',
  onSubmit,
  onClose,
}: {
  title: ReactNode
  description?: ReactNode
  label?: string
  placeholder?: string
  initial?: string
  multiline?: boolean
  submitLabel?: string
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    onClose()
  }
  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      dismissOnOverlayClick={false}
    >
      <form onSubmit={handleSubmit}>
        {label && (
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: 'var(--color-ink-2)',
              marginBottom: 6,
            }}
          >
            {label}
          </label>
        )}
        {multiline ? (
          <textarea
            ref={(el) => {
              inputRef.current = el
            }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            rows={4}
            className="ns-input"
            style={{ width: '100%', resize: 'vertical', minHeight: 100 }}
          />
        ) : (
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="ns-input"
            style={{ width: '100%' }}
          />
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 16,
          }}
        >
          <button type="button" onClick={onClose} className="ns-btn ghost">
            Cancel
          </button>
          <button
            type="submit"
            className="ns-btn primary"
            disabled={!value.trim()}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Confirmation replacement for `window.confirm`. The destructive prop
 * swaps the primary CTA to the brand's danger color.
 */
export function ConfirmModal({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
}: {
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} description={description} onClose={onClose}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: 4,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="ns-btn ghost"
          // Destructive confirms get the safe default: Cancel takes the
          // initial focus so an accidental Enter dismisses rather than
          // committing the dangerous action.
          autoFocus={destructive}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            onConfirm()
            onClose()
          }}
          className="ns-btn"
          // Non-destructive confirms focus the primary so Enter commits
          // immediately — most "are you sure?" flows are benign.
          autoFocus={!destructive}
          style={
            destructive
              ? {
                  background: 'var(--color-error)',
                  color: '#fff',
                  border: '1px solid var(--color-error)',
                }
              : undefined
          }
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
