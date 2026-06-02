/**
 * Model catalog client + cache.
 *
 * Wraps `GET /providers/available` so any UI surface (Preferences,
 * the in-chat model pill, the WorkflowPanel per-stage pickers) can
 * read the same canonical model list — and stay in sync with which
 * providers actually have keys configured server-side.
 *
 * Caching: we hold the response in memory and refresh in the
 * background after `STALE_MS`. Components see an instant first paint
 * once anything has fetched it, and a tab-switch back picks up new
 * server keys without a hard reload. The cache also lives on
 * `localStorage` so a hard reload doesn't show an empty dropdown
 * mid-flight.
 */
import { api } from './api'

export type ProviderId = 'anthropic' | 'openai' | 'google_genai' | 'deepseek' | string

export interface ProviderInfo {
  id: ProviderId
  display_name: string
  has_key: boolean
  env_var: string
}

export interface ModelInfo {
  id: string // canonical "<provider>:<model_id>"
  provider_id: ProviderId
  label: string
  description: string
  kind: 'chat' | 'reasoning'
  available: boolean
  suggested_for: string[]
}

export interface ProvidersAvailable {
  providers: ProviderInfo[]
  models: ModelInfo[]
  /** Operator-set fallback. `null` when `NOTESCI_DEFAULT_MODEL` is
   *  unset — that's the deliberate stance (don't impose a default). */
  default_model: string | null
  /** Model the server will ACTUALLY use when no per-call model is
   *  specified — operator default if available, else the first
   *  available chat model. `null` only when no provider keys exist. */
  fallback_model: string | null
  /** Embedding/indexing availability. Source upload needs this; chat
   *  providers like DeepSeek can still work when this is unavailable. */
  embedding?: {
    available: boolean
    model: string | null
    provider_id: ProviderId | null
    label: string | null
    supported_provider_ids: ProviderId[]
  }
}

const CACHE_KEY = 'notesci_providers_cache_v1'
const STALE_MS = 60_000

interface CachedShape {
  at: number
  data: ProvidersAvailable
}

let inMem: CachedShape | null = null
let inflight: Promise<ProvidersAvailable> | null = null
const SUBS = new Set<(p: ProvidersAvailable) => void>()

function readDisk(): CachedShape | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedShape
    if (typeof parsed?.at !== 'number' || !parsed.data) return null
    // Shape-validate: a cache written by an older / partial build can
    // be missing the `models` or `providers` arrays — returning that
    // here makes consumers like ModelPill crash on `.filter`. Treat
    // a malformed payload as no-cache and let the fresh fetch replace
    // it (writeDisk runs on the next successful getProviders).
    const data = parsed.data as Partial<ProvidersAvailable> | undefined
    if (!Array.isArray(data?.models) || !Array.isArray(data?.providers)) {
      try { localStorage.removeItem(CACHE_KEY) } catch { /* quota / private mode — ignore */ }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeDisk(c: CachedShape) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {
    /* quota or private mode — ignore */
  }
}

/** Snapshot of the catalog without triggering a fetch. */
export function peekProviders(): ProvidersAvailable | null {
  if (inMem) return inMem.data
  const disk = readDisk()
  if (disk) {
    inMem = disk
    return disk.data
  }
  return null
}

/** Fetch (or reuse cached) availability. Always fires off a refresh
 *  when the in-mem entry is older than `STALE_MS` so the next call
 *  picks up new keys. */
export async function getProviders(): Promise<ProvidersAvailable> {
  const cached = peekProviders()
  if (cached && inMem && Date.now() - inMem.at < STALE_MS) {
    return cached
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = await api<ProvidersAvailable>('/providers/available', {
        auth: true,
      })
      // Shape-validate the live response too: a backend regression that
      // dropped the arrays would poison the cache and crash every
      // consumer (ModelPill, ChatPane.submit, model labels in chat
      // bubbles). Patch the missing fields to empty arrays so the rest
      // of the UI degrades gracefully.
      const patched: ProvidersAvailable = {
        providers: Array.isArray(data?.providers) ? data.providers : [],
        models: Array.isArray(data?.models) ? data.models : [],
        default_model: data?.default_model ?? null,
        fallback_model: data?.fallback_model ?? null,
        embedding: data?.embedding,
      }
      inMem = { at: Date.now(), data: patched }
      writeDisk(inMem)
      SUBS.forEach((fn) => fn(patched))
      return patched
    } finally {
      inflight = null
    }
  })()
  // If we have a stale cached value, return it immediately and let the
  // refresh happen in the background — components stay responsive.
  if (cached) {
    inflight.catch(() => {/* swallow; subscribers see nothing */})
    return cached
  }
  return inflight
}

/** Subscribe to catalog refreshes (returns an unsubscribe fn). */
export function subscribeProviders(cb: (p: ProvidersAvailable) => void): () => void {
  SUBS.add(cb)
  return () => {
    SUBS.delete(cb)
  }
}

/** Force a refetch — call after the user reconfigures keys server-side
 *  (currently no UI for that; kept for future. */
export async function refreshProviders(): Promise<ProvidersAvailable> {
  inMem = null
  inflight = null
  return getProviders()
}

/** Drop all in-memory provider catalog state — module cache, in-flight
 *  promise, and subscribers. Invoked from `signOut()` so the next user
 *  on this browser starts with an empty catalog instead of inheriting
 *  the previous user's snapshot. Disk cache (`CACHE_KEY`) is wiped by
 *  the per-user `notesci_*` localStorage sweep in `signOut`. */
export function clearProviderCache(): void {
  inMem = null
  inflight = null
  SUBS.clear()
}

/** Friendly "Anthropic · Claude Sonnet 4.6"-style label. */
export function modelDisplayPath(
  modelId: string | null | undefined,
  catalog?: ProvidersAvailable | null,
): string | null {
  if (!modelId) return null
  const cat = catalog ?? peekProviders()
  if (!cat) return modelId
  // Defensive against a malformed catalog payload (an upstream cache or
  // API regression where `models`/`providers` are missing) — fall back
  // to the raw id rather than throwing during chat-bubble render.
  const m = (cat.models ?? []).find((x) => x.id === modelId)
  if (!m) return modelId
  const p = (cat.providers ?? []).find((x) => x.id === m.provider_id)
  return `${p?.display_name ?? m.provider_id} · ${m.label}`
}

/** Just the model label, no provider. Used in compact contexts. */
export function modelShortLabel(
  modelId: string | null | undefined,
  catalog?: ProvidersAvailable | null,
): string | null {
  if (!modelId) return null
  const cat = catalog ?? peekProviders()
  if (!cat) return modelId
  const m = (cat.models ?? []).find((x) => x.id === modelId)
  return m?.label ?? modelId
}

/** Pick the model the UI should send for the next message — honors
 *  the user's saved preference if available, otherwise the server
 *  fallback, otherwise null (let the server pick its default). */
export function resolveActiveModel(
  preferredId: string | null | undefined,
  catalog?: ProvidersAvailable | null,
): string | null {
  const cat = catalog ?? peekProviders()
  if (!cat) return preferredId ?? null
  if (preferredId) {
    const m = (cat.models ?? []).find((x) => x.id === preferredId)
    if (m && m.available) return m.id
  }
  if (cat.fallback_model) return cat.fallback_model
  return null
}

/** Pick the model used to ingest uploaded materials. Policy:
 *  - if exactly one available model exists, always use it;
 *  - if multiple, honor the user's current preference when available;
 *  - otherwise defer to the catalog fallback (operator default or first
 *    available model).
 */
export function resolveUploadModel(
  preferredId: string | null | undefined,
  catalog?: ProvidersAvailable | null,
): string | null {
  const cat = catalog ?? peekProviders()
  if (!cat) return preferredId ?? null

  const available = (cat.models ?? []).filter((m) => m.available)
  if (available.length === 1) {
    return available[0].id
  }

  if (preferredId) {
    const preferred = available.find((x) => x.id === preferredId)
    if (preferred) return preferred.id
  }

  if (cat.fallback_model) return cat.fallback_model
  return null
}
