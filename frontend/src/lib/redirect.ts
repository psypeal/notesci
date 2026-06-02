import { useSearchParams } from 'react-router'

/** Auth-flow paths that we never redirect *to* after sign-in / claim —
 *  redirecting back here would land the just-authed user on a page that
 *  immediately bounces them to / via RedirectIfAuthed. Sometimes that's
 *  fine, but for `?next=`-targets we want to default to / instead so
 *  shareable links always land somewhere meaningful. */
const AUTH_PATHS = new Set([
  '/sign-in',
  '/claim',
  '/forgot-password',
  '/reset-sent',
  '/reset-password',
  '/verify-email',
  '/waitlist',
  '/invite-claimed',
  '/invite-expired',
])

/** Pure version of `useNextParam` — usable from non-hook contexts like
 *  `RedirectIfAuthed`. Same validation rules.
 *
 *  Rejected (returns `/`):
 *    - missing / empty
 *    - any external URL (must start with single `/`)
 *    - protocol-relative URLs (`//evil.com`)
 *    - backslash-containing values (some browsers normalise `\` →
 *      `/` and treat `\\evil.com` as protocol-relative)
 *    - URL-encoded protocol-relative URLs (`/%2f%2fevil.com` decodes
 *      to `//evil.com`)
 *    - paths inside the auth flow (loop avoidance) */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  if (raw.includes('\\')) return '/'
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.startsWith('//')) return '/'
  } catch {
    // Malformed percent-encoding — refuse to redirect.
    return '/'
  }
  const path = raw.split('?')[0].split('#')[0]
  if (AUTH_PATHS.has(path)) return '/'
  return raw
}

/** Allow only `http:` / `https:` URLs through to `<a target="_blank">`.
 *  Defends against `javascript:`, `data:`, and other dangerous schemes
 *  injected via user-supplied material URIs. Returns true when `s` is
 *  a parseable URL with an http/https scheme. */
export function isSafeHttpUrl(s: string | null | undefined): boolean {
  if (!s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Read the post-auth `?next=<path>` redirect parameter. Returns `/` when
 * the param is missing, empty, points outside the app (defense against
 * open-redirect via crafted links), or targets another auth screen.
 */
export function useNextParam(): string {
  const [params] = useSearchParams()
  return safeNext(params.get('next'))
}

/**
 * Build a path that preserves the current `?next=` query if any. Used to
 * forward the redirect target across cross-links between auth screens
 * (sign-in ↔ claim ↔ forgot-password ↔ waitlist).
 */
export function withNext(path: string, next: string): string {
  if (!next || next === '/') return path
  return `${path}?next=${encodeURIComponent(next)}`
}
