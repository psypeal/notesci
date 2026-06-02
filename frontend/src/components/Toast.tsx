import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'warn' | 'error'
}

interface ToastApi {
  toast(text: string, tone?: Toast['tone']): void
  success(text: string): void
  warn(text: string): void
  error(text: string): void
}

const Ctx = createContext<ToastApi | null>(null)

/**
 * Mount once at the app root. The bottom-center dark pill matches the
 * design's `InviteSentToast` from `states.jsx`. Toasts stack
 * upward when multiple are active; each auto-dismisses after 3 s.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++idRef.current
    setToasts((cur) => [...cur, { id, text, tone }])
    setTimeout(() => {
      setToasts((cur) => cur.filter((t) => t.id !== id))
    }, 3000)
  }, [])

  const api: ToastApi = {
    toast: push,
    success: (t) => push(t, 'success'),
    warn: (t) => push(t, 'warn'),
    error: (t) => push(t, 'error'),
  }

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        // Live region: assistive tech announces each toast as it appears.
        // Per-pill `role` (alert for errors, status otherwise) gives the
        // right urgency without needing two sibling regions.
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'center',
          pointerEvents: 'none',
          zIndex: 200,
        }}
      >
        {toasts.map((t) => (
          <ToastPill key={t.id} t={t} />
        ))}
      </div>
    </Ctx.Provider>
  )
}

function ToastPill({ t }: { t: Toast }) {
  const accent =
    t.tone === 'success'
      ? 'oklch(0.78 0.18 195)'
      : t.tone === 'warn'
        ? 'oklch(0.72 0.16 60)'
        : t.tone === 'error'
          ? 'oklch(0.55 0.20 25)'
          : 'oklch(0.78 0.18 195)'
  const glyph = t.tone === 'error' || t.tone === 'warn' ? '!' : '✓'
  return (
    <div
      role={t.tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 18px',
        background: 'var(--color-ink)',
        color: 'var(--color-paper)',
        borderRadius: 12,
        boxShadow: '0 16px 40px rgba(0,0,0,0.18)',
        fontSize: 13.5,
        pointerEvents: 'auto',
        maxWidth: 480,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          width: 18,
          height: 18,
          borderRadius: 9,
          background: accent,
          color: 'var(--color-ink)',
          fontSize: 11,
          fontWeight: 700,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {glyph}
      </span>
      <span>{t.text}</span>
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx)
  if (!ctx) {
    // Allow callers to ignore toasts when the provider isn't mounted
    // (e.g. unit tests). Silent no-op — earlier versions logged to
    // console, but that produced noise in prod when stray providers
    // weren't mounted on an error path. Tests don't need the output
    // either.
    return {
      toast: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
    }
  }
  return ctx
}

// On effect: convenience that fires a toast once when `text` becomes
// truthy. Useful for "saved" / "copied" indicators tied to react state.
export function useToastWhen(text: string | null, tone: Toast['tone'] = 'info') {
  const { toast } = useToast()
  useEffect(() => {
    if (text) toast(text, tone)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
}
