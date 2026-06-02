/**
 * User preferences (read by PreferencesPage + ChatPane model pill).
 * Applied as `data-` attributes on `<html>` so CSS can react.
 *
 * `defaultModel` is the canonical `<provider>:<model_id>` string used
 * by the backend's `init_chat_model` (e.g.
 * `"anthropic:claude-sonnet-4-6"`). It deliberately is NOT a hardcoded
 * union — the source of truth is the server-curated catalog at
 * `/providers/available`. Callers that need a friendly label use
 * `modelShortLabel()` from `lib/models.ts`.
 *
 * Legacy preference values from before May 2026 used short ids like
 * `"claude-sonnet-4-6"`. `migrateLegacyModelId()` maps those forward
 * the first time the file is read on each device — keeps existing
 * users from losing their pick during the schema change.
 */

export interface PrefsState {
  /** Canonical "<provider>:<model_id>" or null to defer to the server. */
  defaultModel: string | null
  defaultStyle: 'fast' | 'balanced' | 'thorough'
  graphMode: 'citations' | 'concepts' | 'reasoning'
  density: 'comfortable' | 'compact'
  theme: 'paper' | 'plain'
  /** Chat retrieval mode. 'vector' is the default pgvector kNN path;
   *  'tree' uses the PageIndex tree-walk and silently falls back to
   *  vector when no trees are ready in the project. */
  retrievalMode: 'vector' | 'tree'
}

export const DEFAULT_PREFS: PrefsState = {
  defaultModel: null, // null = "use the server default"
  defaultStyle: 'thorough',
  graphMode: 'citations',
  density: 'comfortable',
  theme: 'paper',
  retrievalMode: 'vector',
}

/** Map legacy short ids → canonical "<provider>:<model_id>". Returns
 *  the input unchanged if it already looks canonical (`provider:model`)
 *  or if it's not a known legacy id. */
export function migrateLegacyModelId(v: unknown): string | null {
  if (!v || typeof v !== 'string') return null
  if (v.includes(':')) return v // already canonical
  switch (v) {
    case 'claude-opus-4-7':
      return 'anthropic:claude-opus-4-7'
    case 'claude-sonnet-4-6':
      return 'anthropic:claude-sonnet-4-6'
    case 'gpt-5':
      return 'openai:gpt-5'
    case 'deepseek-chat':
      return 'deepseek:deepseek-chat'
    default:
      return null
  }
}

export const PREFS_KEY = 'notesci_prefs'

export function readPrefs(): PrefsState {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PrefsState>
    return {
      ...DEFAULT_PREFS,
      ...raw,
      defaultModel: migrateLegacyModelId(raw.defaultModel) ?? raw.defaultModel ?? null,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function writePrefs(next: PrefsState) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  } catch {
    /* quota / private mode — ignore */
  }
  applyPrefs(next)
  window.dispatchEvent(new Event('notesci-prefs-changed'))
}

/** Update a single pref key. Convenience over readPrefs/writePrefs round-trips. */
export function patchPrefs<K extends keyof PrefsState>(key: K, value: PrefsState[K]) {
  const next = { ...readPrefs(), [key]: value }
  writePrefs(next)
}

/** Apply theme + density as data-attrs on `<html>` so CSS can react. */
export function applyPrefs(prefs: PrefsState = readPrefs()) {
  const root = document.documentElement
  root.dataset.theme = prefs.theme
  root.dataset.density = prefs.density
}
