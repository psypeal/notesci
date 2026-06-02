// Thin access to the Tauri command bridge.
//
// The desktop build runs the SPA inside a WebKitGTK WebView with
// ``withGlobalTauri`` enabled, so ``invoke`` is reachable on the window
// object. In the plain browser/dev build it's absent — callers fall back
// to web behaviour (e.g. ``window.open``). Keeping the lookup in one place
// avoids re-deriving the ``__TAURI__`` / ``__TAURI_INTERNALS__`` shape at
// each call site (cf. the inline copy in PdfReader's export path).

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

type ListenFn = (
  event: string,
  handler: (e: { payload: unknown }) => void,
) => Promise<() => void>

type TauriGlobal = {
  __TAURI__?: {
    core?: { invoke?: InvokeFn }
    event?: { listen?: ListenFn }
  }
  __TAURI_INTERNALS__?: { invoke?: InvokeFn }
}

/** The Tauri ``invoke`` function when running inside the desktop shell,
 *  otherwise ``null``. */
export function tauriInvoke(): InvokeFn | null {
  const t = window as unknown as TauriGlobal
  return t.__TAURI__?.core?.invoke ?? t.__TAURI_INTERNALS__?.invoke ?? null
}

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return tauriInvoke() !== null
}

/** Open ``url`` in the OS default browser (desktop), or a new tab (web).
 *  ``window.open`` is a no-op under WebKitGTK, so the desktop path goes
 *  through the ``open_url`` Rust command and only falls back on error. */
export function openInSystemBrowser(url: string): void {
  const invoke = tauriInvoke()
  if (invoke) {
    void invoke('open_url', { url }).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer')
    })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Open ``url`` in an in-app browser window (desktop) — a real top-level
 *  WebView that, unlike an ``<iframe>``, isn't blocked by the site's
 *  ``X-Frame-Options`` / CSP. On the web build, falls back to a new tab. */
export function openLivePreview(url: string, title?: string | null): void {
  const invoke = tauriInvoke()
  if (invoke) {
    void invoke('open_link_preview', { url, title: title ?? null }).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer')
    })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Embed (or reposition) the in-app browser preview as a native webview
 *  overlaid on the modal's content area at the given CSS-pixel rect.
 *  Desktop only; no-op on the web build. Returns true when the request
 *  was dispatched to Tauri. */
export function embedPreview(
  url: string,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const invoke = tauriInvoke()
  if (!invoke) return false
  void invoke('embed_preview', {
    url,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }).catch(() => {})
  return true
}

/** Tear down the embedded preview webview. No-op on the web build. */
export function closePreview(): void {
  const invoke = tauriInvoke()
  if (invoke) void invoke('close_preview').catch(() => {})
}

/** Capture the embedded preview's rendered page text (drives the
 *  source-captured event the host ingests). No-op on the web build. */
export function captureFromPreview(): void {
  const invoke = tauriInvoke()
  if (invoke) void invoke('capture_from_preview').catch(() => {})
}

/** Spawn a hidden loader window that opens ``url`` in a real browser,
 *  clears any JS/Cloudflare challenge, and reports the rendered page back
 *  via the ``preview-bytes`` event. Returns true if dispatched (desktop),
 *  false on the web build (no native loader available). */
export function startPreviewFetch(url: string): boolean {
  const invoke = tauriInvoke()
  if (!invoke) return false
  void invoke('start_preview_fetch', { url }).catch(() => {})
  return true
}

/** Close the loader window without waiting (user dismissed / backed out). */
export function cancelPreviewFetch(): void {
  const invoke = tauriInvoke()
  if (invoke) void invoke('cancel_preview_fetch').catch(() => {})
}

/** Subscribe to a Tauri backend event. Returns an unsubscribe function;
 *  no-ops (and returns a no-op unsubscribe) on the web build. */
export function onTauriEvent<T = unknown>(
  name: string,
  handler: (payload: T) => void,
): () => void {
  const t = window as unknown as TauriGlobal
  const listen = t.__TAURI__?.event?.listen
  if (!listen) return () => {}
  let unlisten: (() => void) | null = null
  let cancelled = false
  void listen(name, (e) => handler(e.payload as T))
    .then((un) => {
      if (cancelled) un()
      else unlisten = un
    })
    .catch(() => {
      /* event API unavailable — nothing to clean up */
    })
  return () => {
    cancelled = true
    if (unlisten) unlisten()
  }
}
