import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmModal } from '../components/Modal'

interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void
}

/**
 * Promise-based replacement for `window.confirm`. Returns a `[confirm,
 * dialog]` pair — call `confirm(opts)` to get a Promise that resolves
 * to true/false; render `{dialog}` somewhere in the tree to mount the
 * modal. The native dialog leaks "127.0.0.1 says" chrome in the Tauri
 * webview, which looks broken; this surfaces the in-app ConfirmModal
 * instead.
 */
export function useConfirm(): [
  (opts: ConfirmOptions) => Promise<boolean>,
  ReactNode,
] {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const pendingRef = useRef<PendingConfirm | null>(null)
  pendingRef.current = pending

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve })
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    const p = pendingRef.current
    if (!p) return
    pendingRef.current = null
    setPending(null)
    p.resolve(value)
  }, [])

  const dialog = pending ? (
    <ConfirmModal
      title={pending.title}
      description={pending.description}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      destructive={pending.destructive}
      onConfirm={() => settle(true)}
      onClose={() => settle(false)}
    />
  ) : null

  return [confirm, dialog]
}
