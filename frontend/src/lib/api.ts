/**
 * Tiny fetch wrapper for the notesci backend.
 *
 * - Goes through the Vite proxy in dev (`/api/*` → `:8000`) so we don't
 *   need CORS setup; in prod the same prefix can be served by the same
 *   origin or rewritten by the edge.
 * - Surfaces typed error codes (`detail.code`) when the backend returns
 *   them so screens can render exact design states.
 * - Persists the bearer token in `localStorage["notesci_token"]`.
 */

export const TOKEN_KEY = 'notesci_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** localStorage keys that survive sign-out — they're per-browser UI
 *  preferences, not user data, so resetting them on every sign-out
 *  would feel like the workspace forgot the user's last layout each
 *  time. The token, active_*, drafts, annotations, workspace id, and
 *  OAuth callback state ARE wiped (see `signOut`). */
const PRESERVE_ON_SIGNOUT = new Set<string>([
  'notesci_workspace_layout',
  'notesci_side_open',
  'notesci_split_chat',
  'notesci_split_reader',
  'notesci_split_draft',
  'notesci_graph_mode',
])

/**
 * Best-effort sign-out — runs in a strict order so an in-flight request
 * from another tab can't sneak through with a now-revoked token, and so
 * no module-level cache (parsed PDFs, fetched material bytes, stitched
 * content) outlives the sign-out:
 *
 *   1. Clear the local bearer synchronously — any concurrent fetch on
 *      another tab loses its auth header on its next read of
 *      `localStorage`.
 *   2. POST `/auth/signout` (best-effort; the server-side session is
 *      invalidated even if this races a network failure).
 *   3. Wipe every per-user `notesci_*` localStorage key, but preserve
 *      UI prefs the browser would otherwise forget.
 *   4. Flush the ReaderPane + PdfReader module caches so the reader
 *      doesn't paint the previous user's document on the next sign-in.
 *   5. Hard reload to `/sign-in` so any other in-memory module state
 *      (component caches, in-flight requests still pending in a `void
 *      (async () => …)` IIFE) is wiped by the page navigation.
 *
 * Failures from step 2 are swallowed — the user's intent is to sign
 * out either way; we never want a "couldn't sign out" page when the
 * local token is already gone.
 */
export async function signOut(): Promise<void> {
  // 1. Drop the token synchronously, BEFORE the POST: other tabs reading
  //    the token mid-request will see it gone and their next call will
  //    fail with 401 → notesci-auth-expired (no chance of acting on the
  //    just-signed-out account).
  setToken(null)
  // 2. Best-effort revoke on the server.
  try {
    await api('/auth/signout', { method: 'POST', auth: true })
  } catch {
    /* best-effort */
  }
  // 3. Wipe per-user state but keep UI prefs.
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('notesci_') && !PRESERVE_ON_SIGNOUT.has(k)) {
      keys.push(k)
    }
  }
  for (const k of keys) localStorage.removeItem(k)
  // 4. Flush in-memory module caches (PDF docs, material bytes, etc.).
  //    Done via dynamic imports because `signOut` is part of the
  //    shared lib bundle that the auth screens load too — eagerly
  //    importing ReaderPane there would defeat the pdfjs lazy-load.
  try {
    const reader = await import('../components/workspace/ReaderPane')
    reader.clearReaderCaches()
  } catch {
    /* the reader chunk hadn't been loaded yet — nothing to clear */
  }
  // Provider catalog + splitter session state: these live in module
  // scope on the workspace bundle. Clearing them here means the
  // in-memory contract holds even if the page-reload in step 5 is
  // someday dropped (e.g. for a smoother in-SPA sign-out).
  try {
    const models = await import('./models')
    models.clearProviderCache()
  } catch {
    /* not loaded yet — nothing to clear */
  }
  try {
    const split = await import('../components/workspace/ResizableSplit')
    split.clearResizableSplitState()
  } catch {
    /* not loaded yet — nothing to clear */
  }
  // 5. Belt-and-suspenders: hard reload so any other in-memory state
  //    is reset. Callers that wanted in-SPA navigation can pass their
  //    own routing; the security contract here outweighs that nicety.
  if (typeof window !== 'undefined') {
    // Local-mode desktop: no sign-in UI. Reload to the root and let
    // the backend's bootstrap inject a fresh token via index.html.
    window.location.assign('/')
  }
}

/** Standard "you're offline" message — kept in one place so the wording
 *  stays consistent across the auth flow, dashboard, and workspace. */
export const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again."

/** Standard rate-limit message. Surfaced when the backend returns
 *  `code: 'rate_limited'` from auth flows (sign-in, claim, forgot-password,
 *  waitlist). */
export const RATE_LIMITED_MESSAGE =
  'Too many attempts. Try again in a minute.'

/**
 * Convenience: turn a thrown unknown into a user-facing error message.
 * Branches on the `network_error` code from the api lib — falls through
 * to the caller's `fallback` for any other failure (HTTP 4xx/5xx).
 */
export function errorMessage(err: unknown, fallback: string): string {
  const e = err as { code?: string }
  if (e?.code === 'network_error') return NETWORK_ERROR_MESSAGE
  return fallback
}

export interface ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server
   *  (offline, DNS failure, CORS preflight rejected, etc.). */
  status: number
  code?: string
}

/**
 * Authenticated binary fetch — returns a `Blob`. Used when the response
 * isn't JSON (e.g. PDF byte serving for the reader pane). Same auth +
 * error-shape contract as :func:`api`, just no body parsing.
 */
export async function apiBlob(
  path: string,
  init: RequestInit & { auth?: boolean; signal?: AbortSignal } = {},
): Promise<Blob> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (init.auth) {
    const t = getToken()
    if (t) headers.authorization = `Bearer ${t}`
  }
  let r: Response
  try {
    r = await fetch(`/api${path}`, { ...init, headers, signal: init.signal })
  } catch (cause) {
    const err = new Error('network error') as ApiError
    err.status = 0
    err.code = 'network_error'
    err.cause = cause
    throw err
  }
  if (!r.ok) {
    if (r.status === 401 && init.auth) {
      setToken(null)
      window.dispatchEvent(new Event('notesci-auth-expired'))
    }
    const err = new Error(`request failed (${r.status})`) as ApiError
    err.status = r.status
    throw err
  }
  return r.blob()
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (init.auth) {
    const t = getToken()
    if (t) headers.authorization = `Bearer ${t}`
  }
  let r: Response
  try {
    r = await fetch(`/api${path}`, { ...init, headers })
  } catch (cause) {
    // Network failure: fetch itself threw (offline, DNS, CORS rejected).
    // Re-throw as an ApiError with status 0 so callers can dispatch on
    // status alone instead of having to discriminate by error type.
    const err = new Error('network error') as ApiError
    err.status = 0
    err.code = 'network_error'
    err.cause = cause
    throw err
  }
  if (!r.ok) {
    let body: unknown = null
    try {
      body = await r.json()
    } catch {
      // ignore
    }
    const detail = (body as { detail?: { code?: string; message?: string } })?.detail
    const err = new Error(detail?.message || `request failed (${r.status})`) as ApiError
    err.status = r.status
    err.code = detail?.code
    // Centralized auth-expired handling: when an authed call returns
    // 401, clear the token and broadcast so the router can redirect
    // anyone watching to /sign-in. Page-level handlers can still catch
    // the error to render their own messaging.
    if (r.status === 401 && init.auth) {
      setToken(null)
      window.dispatchEvent(new Event('notesci-auth-expired'))
    }
    throw err
  }
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

export async function apiSse(
  path: string,
  init: RequestInit & { auth?: boolean },
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (init.auth) {
    const t = getToken()
    if (t) headers.authorization = `Bearer ${t}`
  }
  let r: Response
  try {
    r = await fetch(`/api${path}`, { ...init, headers })
  } catch (cause) {
    if ((cause as DOMException | undefined)?.name === 'AbortError') {
      const err = new Error('aborted') as ApiError
      err.name = 'AbortError'
      err.status = 0
      err.code = 'aborted'
      err.cause = cause
      throw err
    }
    const err = new Error('network error') as ApiError
    err.status = 0
    err.code = 'network_error'
    err.cause = cause
    throw err
  }
  if (!r.ok || !r.body) {
    const err = new Error(`request failed (${r.status})`) as ApiError
    err.status = r.status
    throw err
  }

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx = buf.indexOf('\n\n')
    while (idx !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed.type === 'error') {
          const err = new Error(String(parsed.message ?? 'Agent failed.')) as ApiError
          err.status = 502
          err.code = typeof parsed.code === 'string' ? parsed.code : 'agent_failed'
          throw err
        }
        onEvent(parsed)
      }
      idx = buf.indexOf('\n\n')
    }
  }
}

/**
 * Authenticated `multipart/form-data` POST/PUT — used by file uploads
 * (`/materials/ingest-pdf`). We deliberately do NOT set the
 * `content-type` header: the browser computes the multipart boundary
 * for us, and a manually-supplied content-type would strip it and
 * make the server reject the body.
 *
 * Same 401 → `notesci-auth-expired` dispatch as :func:`api` so a
 * stale-session upload doesn't silently fail.
 */
export async function apiForm<T = unknown>(
  path: string,
  body: FormData,
  init: { auth?: boolean; signal?: AbortSignal; method?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.auth) {
    const t = getToken()
    if (t) headers.authorization = `Bearer ${t}`
  }
  let r: Response
  try {
    r = await fetch(`/api${path}`, {
      method: init.method ?? 'POST',
      headers,
      body,
      signal: init.signal,
    })
  } catch (cause) {
    const err = new Error('network error') as ApiError
    err.status = 0
    err.code = 'network_error'
    err.cause = cause
    throw err
  }
  if (!r.ok) {
    let parsed: unknown = null
    try {
      parsed = await r.json()
    } catch {
      /* ignore */
    }
    const detail = (parsed as { detail?: { code?: string; message?: string } })?.detail
    const err = new Error(detail?.message || `request failed (${r.status})`) as ApiError
    err.status = r.status
    err.code = detail?.code
    if (r.status === 401 && init.auth) {
      setToken(null)
      window.dispatchEvent(new Event('notesci-auth-expired'))
    }
    throw err
  }
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}
