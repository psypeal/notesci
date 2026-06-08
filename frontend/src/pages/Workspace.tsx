import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { TopBar, SidebarGlyph, type LayoutMode } from '../components/workspace/TopBar'
import {
  SidePanel,
  type MaterialItem,
  type SessionItem,
} from '../components/workspace/SidePanel'
import { ChatPane } from '../components/workspace/ChatPane'
import { GraphPane, PaneErrorBoundary, type GraphMode } from '../components/workspace/GraphPane'
import { ReaderPane, invalidateMaterialCache } from '../components/workspace/ReaderPane'
import { DrafterPane } from '../components/workspace/DrafterPane'
import { ResizableSplit, expandSplit } from '../components/workspace/ResizableSplit'
import { DefaultEmptyHero } from '../components/workspace/DefaultEmptyHero'
import {
  EmptyCard,
  MaterialsIllus,
  ProjectsIllus,
} from '../components/workspace/Empty'
import { Lockup } from '../components/brand/Lockup'
import { Icons } from '../components/icons'
import { SmallScreenNotice } from '../components/SmallScreenNotice'
import { useToast } from '../components/Toast'
import { Modal, TextPromptModal } from '../components/Modal'
import { useConfirm } from '../lib/useConfirm'
import { usePageTitle } from '../lib/title'
import {
  CommandPalette,
  buildDefaultItems,
  useCommandPalette,
} from '../components/workspace/CommandPalette'
import {
  IngestionStrip,
  useIngestionTracker,
  type IngestionJob,
} from '../components/workspace/IngestionTracker'
import { UploadProgressView } from '../components/workspace/UploadProgressView'
import { api, apiForm, errorMessage, getToken, type ApiError } from '../lib/api'
import { initialsFor } from '../lib/initials'
import { getProviders, resolveUploadModel } from '../lib/models'
import { readPrefs } from '../lib/prefs'
import { isSafeHttpUrl } from '../lib/redirect'
import { openInSystemBrowser } from '../lib/tauri'

interface MeOut {
  id: string
  workspace_id: string
  email: string
  display_name: string | null
  email_verified: boolean
}

interface ProjectOut {
  id: string
  workspace_id: string
  name: string
  created_at: string
  updated_at: string
}

const LAYOUT_KEY = 'notesci_workspace_layout'
const ACTIVE_PROJECT_KEY = 'notesci_active_project'
const ACTIVE_SESSION_KEY = 'notesci_active_session'
const ACTIVE_MATERIAL_KEY = 'notesci_active_material'
const SIDE_OPEN_KEY = 'notesci_side_open'
const GRAPH_MODE_KEY = 'notesci_graph_mode'

const GRAPH_MODE_BY_DIGIT: Record<string, GraphMode> = {
  '0': 'map',
  '1': 'citations',
  '2': 'concepts',
  '3': 'reasoning',
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuidLike(value: string): boolean {
  return UUID_RE.test(value)
}

/** Resolve a stored layout value to a current LayoutMode. Migrates the
 *  pre-May-11-2026 names ('default' / 'reading' / 'drafting') forward
 *  so existing users keep their last selection without surprise. */
function migrateLayoutMode(raw: string | null): LayoutMode {
  if (raw === 'chat' || raw === 'reader' || raw === 'draft') return raw
  if (raw === 'default') return 'chat'
  if (raw === 'reading') return 'reader'
  if (raw === 'drafting') return 'draft'
  return 'chat'
}

/** One-shot localStorage migration for split-pane ratios renamed
 *  alongside the layout modes. Old keys: notesci_split_default /
 *  _reading / _drafting. New keys: notesci_split_chat / _reader /
 *  _draft. Collapsed-state localStorage keys are removed outright —
 *  collapse is now session-scoped (lives in module state inside
 *  ResizableSplit) so users don't return to a folded pane they
 *  don't remember setting.
 *
 *  Short-circuits on subsequent loads via the `notesci_migrated_2026_05`
 *  flag so it doesn't iterate localStorage on every page load. Run
 *  from a `useEffect` inside `WorkspacePage` (below) so the scan
 *  doesn't fire on the sign-in route — only signed-in users
 *  ever produced these legacy keys.
 *
 *  TODO(2026-06): remove this entire migration block — flag has been
 *  set for all active users for >30 days. */
function migrateSplitKeys() {
  if (typeof window === 'undefined') return
  const MIGRATION_FLAG = 'notesci_migrated_2026_05'
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return
  } catch {
    /* private mode / quota — fall through and run the migration once
       per page load in that case (no flag to read) */
  }
  const ratioMap: Record<string, string> = {
    notesci_split_default: 'notesci_split_chat',
    notesci_split_reading: 'notesci_split_reader',
    notesci_split_drafting: 'notesci_split_draft',
  }
  const obsoleteKeys = [
    'notesci_split_default_collapsed',
    'notesci_split_reading_collapsed',
    'notesci_split_drafting_collapsed',
    // Drop the new-name collapsed keys too — the stale migrated
    // values that triggered the unwanted auto-fold live here.
    'notesci_split_chat_collapsed',
    'notesci_split_reader_collapsed',
    'notesci_split_draft_collapsed',
  ]
  try {
    for (const [oldKey, newKey] of Object.entries(ratioMap)) {
      const v = localStorage.getItem(oldKey)
      if (v != null && localStorage.getItem(newKey) == null) {
        localStorage.setItem(newKey, v)
      }
    }
    for (const key of obsoleteKeys) {
      localStorage.removeItem(key)
    }
    localStorage.setItem(MIGRATION_FLAG, '1')
  } catch {
    /* private mode / quota — ignore */
  }
}

/**
 * 3-pane workspace shell. Default layout: SidePanel · ChatPane · GraphPane.
 *
 * On first paint:
 *  - Fetch /me, /projects, /invites
 *  - Pick a project (last-active from localStorage, falling back to first)
 *  - Auto-create a project if the workspace has none
 *  - Load that project's sessions + materials
 *  - Pick a session (last-active or null — chat-pane handles "new")
 *
 * Reading + Drafting modes are stubbed to fall back to the default
 * compose; full ReaderPane / DrafterPane land in the next iteration.
 */
export function WorkspacePage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // Path-param routing: when mounted via /p/:projectId, the path param is
  // the canonical source for which project to load. Falls back to
  // ?project= and localStorage when the page is mounted at /. The deep-
  // link useEffect below (~line 316) consumes this on first paint.
  const { projectId: pathProjectId } = useParams<{ projectId: string }>()
  const toast = useToast()
  const [confirm, confirmDialog] = useConfirm()
  const [me, setMe] = useState<MeOut | null>(null)
  const [projects, setProjects] = useState<ProjectOut[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_PROJECT_KEY),
  )
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [materials, setMaterials] = useState<MaterialItem[]>([])
  // Distinguishes "haven't loaded yet" from "loaded and empty" so the
  // empty-materials state doesn't flash before the fetch resolves.
  const [materialsLoaded, setMaterialsLoaded] = useState(false)
  // Materials-changed signal: emitted as a window event when the
  // materials list changes (upload, delete, project switch). GraphPane
  // listens via `notesci-materials-changed` and re-fetches the
  // project map / session graph. Matches the existing
  // `notesci-auth-expired` / `notesci-prefs-changed` event pattern so
  // we don't have to thread a refresh prop through every render path.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_SESSION_KEY),
  )
  // `layout` is derived from the URL so the browser's back/forward
  // buttons navigate between modes (chat/reader/draft) instead of
  // skipping back to whatever page preceded the workspace. The
  // deep-link effect below backfills `?layout=` on direct visits to `/`
  // so a user's last-active mode is still restored from localStorage
  // — but via `replace: true`, so the back-button still leaves the
  // workspace cleanly.
  const layout: LayoutMode = (() => {
    const u = searchParams.get('layout')
    return u ? migrateLayoutMode(u) : 'chat'
  })()
  const [activeMaterialId, setActiveMaterialId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_MATERIAL_KEY),
  )
  // One-shot draft pushed into ChatPane's composer (used by empty-session
  // starter chips). Bumping `nonce` forces the consumer's `useEffect` to
  // re-fire even if the user picks the same chip twice.
  const [composerDraft, setComposerDraft] = useState<{
    text: string
    nonce: number
    // When true, ChatPane auto-fires its `submit()` on mount so the
    // prompt actually goes to the backend instead of just being
    // staged in the composer. Set by the hero's Send / Enter so
    // users don't have to press Send a second time on the chat pane.
    autoSend?: boolean
  } | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [sideOpen, setSideOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(SIDE_OPEN_KEY)
    return saved === null ? true : saved === '1'
  })
  const [graphMode, setGraphMode] = useState<GraphMode>(() => {
    const saved = localStorage.getItem(GRAPH_MODE_KEY) as GraphMode | null
    return saved ?? 'citations'
  })
  const setAndPersistGraphMode = (m: GraphMode) => {
    setGraphMode(m)
    localStorage.setItem(GRAPH_MODE_KEY, m)
  }
  const [error, setError] = useState<string | null>(null)

  // One-shot legacy split-pane key migration. Lives inside the
  // component so the localStorage scan doesn't fire on the sign-in
  // route (where there's no token and therefore no legacy keys to
  // migrate). See `migrateSplitKeys` above for the full migration
  // contract.
  useEffect(() => {
    if (!getToken()) return
    migrateSplitKeys()
  }, [])

  // Multi-tab sync: when another tab switches projects/sessions/etc.,
  // mirror the change here so both tabs stay coherent. The `storage`
  // event only fires for localStorage changes in *other* tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVE_PROJECT_KEY && e.newValue !== activeProjectId) {
        setActiveProjectId(e.newValue)
      }
      if (e.key === ACTIVE_SESSION_KEY && e.newValue !== activeSessionId) {
        setActiveSessionId(e.newValue)
      }
      if (e.key === ACTIVE_MATERIAL_KEY && e.newValue !== activeMaterialId) {
        setActiveMaterialId(e.newValue)
      }
      if (e.key === LAYOUT_KEY && e.newValue && e.newValue !== layout) {
        // Cross-tab layout sync: mirror via the URL with replace so
        // the receiving tab doesn't gain a stray back-stack entry
        // from another tab's interaction.
        const incoming = migrateLayoutMode(e.newValue)
        const next = new URLSearchParams(searchParams)
        if (incoming === 'chat') next.delete('layout')
        else next.set('layout', incoming)
        setSearchParams(next, { replace: true })
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [activeProjectId, activeSessionId, activeMaterialId, layout, searchParams, setSearchParams])

  // Keyboard shortcuts documented in /settings/shortcuts:
  //   ⌘\\ / Ctrl+\\        — toggle side panel
  //   ⌘1 / ⌘2 / ⌘3        — switch graph mode (citations / concepts / reasoning)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only fire on ⌘/Ctrl alone — leave ⌘⇧, ⌘⌥ combinations to the
      // browser and OS so we don't hijack system shortcuts.
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key === '\\') {
        e.preventDefault()
        setSideOpen((cur) => {
          const next = !cur
          localStorage.setItem(SIDE_OPEN_KEY, next ? '1' : '0')
          return next
        })
        return
      }
      const mode = GRAPH_MODE_BY_DIGIT[e.key]
      if (mode) {
        // Skip when the user is typing — ⌘1/⌘2/⌘3 collide with the
        // browser's "switch to tab N" so we'd silently change graph
        // mode in the background while the user expected a tab swap.
        // Letting the browser's system shortcut win when focus is in a
        // text field keeps the surprising-action class out of the
        // common typing path.
        const tgt = document.activeElement
        const tag = tgt?.tagName
        const editable =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          (tgt as HTMLElement | null)?.isContentEditable
        if (editable) return
        e.preventDefault()
        setAndPersistGraphMode(mode)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // URL deep-link: `?project=<id>&session=<id>&material=<id>` overrides
  // the saved localStorage state on first paint, so a share-link
  // recipient lands on the same view. Those three params are
  // consumed (cleared from the URL) because they're one-shot
  // payloads, not navigable state. `?layout=`, by contrast, IS
  // navigable state — it stays in the URL while the user is in the
  // workspace so browser back/forward moves between chat/reader/draft.
  //
  // On a direct visit to `/` (no `?layout=`), back-fill the URL from
  // localStorage with `replace: true` so the user's last mode is
  // restored without adding a history entry. This keeps the
  // back-button's exit point (whatever preceded the workspace) intact.
  useEffect(() => {
    // Path param (/p/:projectId) wins over ?project= query param, which
    // wins over localStorage. This ordering lets share-links and direct
    // navigation both work while preserving the user's last project as
    // a fallback when they land on a bare /p/ URL or /.
    const projectFromUrl = pathProjectId || searchParams.get('project')
    const sessionFromUrl = searchParams.get('session')
    const materialFromUrl = searchParams.get('material')
    const urlLayout = searchParams.get('layout')
    if (projectFromUrl) {
      setActiveProjectId(projectFromUrl)
      localStorage.setItem(ACTIVE_PROJECT_KEY, projectFromUrl)
    }
    if (sessionFromUrl) {
      setActiveSessionId(sessionFromUrl)
      localStorage.setItem(ACTIVE_SESSION_KEY, sessionFromUrl)
    }
    if (materialFromUrl) {
      setActiveMaterialId(materialFromUrl)
      localStorage.setItem(ACTIVE_MATERIAL_KEY, materialFromUrl)
    }
    const next = new URLSearchParams(searchParams)
    let dirty = false
    if (projectFromUrl) { next.delete('project'); dirty = true }
    if (sessionFromUrl) { next.delete('session'); dirty = true }
    if (materialFromUrl) { next.delete('material'); dirty = true }
    if (!urlLayout) {
      const saved = migrateLayoutMode(localStorage.getItem(LAYOUT_KEY))
      if (saved !== 'chat') {
        next.set('layout', saved)
        dirty = true
      }
    }
    if (dirty) {
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist the URL-derived layout so direct visits to `/` can
  // restore the user's last-used mode.
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout)
  }, [layout])


  // Load identity, projects, invite count.
  useEffect(() => {
    void (async () => {
      try {
        const [meRes, pjRes] = await Promise.all([
          api<MeOut>('/me', { auth: true }),
          api<ProjectOut[]>('/projects', { auth: true }),
        ])
        setMe(meRes)
        setProjects(pjRes)

        // First-run users (no projects) see the Welcome state and pick a
        // name explicitly. Otherwise prefer the last-active project, then
        // the first.
        if (pjRes.length > 0) {
          const stored = localStorage.getItem(ACTIVE_PROJECT_KEY)
          const picked =
            (stored && pjRes.find((p) => p.id === stored)?.id) || pjRes[0].id
          setActiveProjectId(picked)
          localStorage.setItem(ACTIVE_PROJECT_KEY, picked)
        }
      } catch (err) {
        setError(
          errorMessage(
            err,
            "Couldn't load your workspace. Try signing out and back in.",
          ),
        )
      }
    })()
  }, [])

  // When project changes, reload its sessions + materials.
  useEffect(() => {
    if (!activeProjectId) return
    setError(null)
    // Reset the gate so we don't flash the empty state for the new
    // project while its materials are still loading.
    setMaterialsLoaded(false)
    // Clear the previous project's lists so the SidePanel and chat
    // scope strip don't briefly show the wrong project's data while
    // the new fetch is in flight.
    setSessions([])
    setMaterials([])
    let aborted = false
    void (async () => {
      try {
        const [sessRes, matRes] = await Promise.all([
          api<{
            id: string
            project_id: string
            title: string | null
            created_at: string
            updated_at: string
          }[]>(`/projects/${activeProjectId}/sessions`, { auth: true }),
          api<{
            id: string
            project_id: string
            source_type: string
            title: string | null
            uri: string | null
            created_at: string
          }[]>(`/projects/${activeProjectId}/materials`, { auth: true }),
        ])
        if (aborted) return
        setSessions(
          sessRes.map((s) => ({
            id: s.id,
            title: s.title,
            updated_at: s.updated_at,
          })),
        )
        setMaterials(
          matRes.map((m) => ({
            id: m.id,
            title: m.title,
            source_type: m.source_type,
            uri: m.uri,
            created_at: m.created_at,
          })),
        )
        setMaterialsLoaded(true)
        // Project switch — kick the graph so the Map view re-fetches.
        window.dispatchEvent(new Event('notesci-materials-changed'))
        // If the stored session belongs to this project's set, keep it; else null.
        const stored = localStorage.getItem(ACTIVE_SESSION_KEY)
        if (stored && sessRes.some((s) => s.id === stored)) {
          setActiveSessionId(stored)
        } else {
          setActiveSessionId(null)
        }
        // Same validation for the active material — a persisted id from a
        // previous project would otherwise 404 the Reader silently.
        const storedMat = localStorage.getItem(ACTIVE_MATERIAL_KEY)
        if (storedMat && matRes.some((m) => m.id === storedMat)) {
          setActiveMaterialId(storedMat)
        } else {
          setActiveMaterialId(null)
        }
      } catch (err) {
        if (!aborted) {
          setError(errorMessage(err, "Couldn't load this project's data."))
        }
      }
    })()
    return () => {
      aborted = true
    }
  }, [activeProjectId])

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  )
  usePageTitle(activeProject ? activeProject.name : 'Workspace')

  const onSelectSession = (id: string) => {
    setActiveSessionId(id)
    localStorage.setItem(ACTIVE_SESSION_KEY, id)
    // A user-driven session switch should not carry over a stale
    // starter draft — that would prefill another session's composer
    // with text the user picked for the welcome state.
    setComposerDraft(null)
    // Picking a session is a request to *read that session* — but in
    // reader/draft layout there's no ChatPane mounted, so the click
    // would silently do nothing. Snap back to chat layout so the
    // selected session actually shows. (Bug: "if I switched to reader
    // mode, I cannot back to the session by clicking the session.")
    if (layout !== 'chat') onLayoutChange('chat')
    // Force the chat split to expand: if the user previously collapsed
    // the chat pane in chat mode, that collapsed state would otherwise
    // persist and the chat would stay hidden after the click. The
    // collapsed state map is keyed by `storageKey`, so resetting only
    // affects the chat split — the graph side keeps its layout
    // preference. (See ResizableSplit.expandSplit's docstring for the
    // companion reader-mode-hide repro that motivated this.)
    expandSplit('notesci_split_chat')
  }
  const onNewSession = () => {
    setActiveSessionId(null)
    localStorage.removeItem(ACTIVE_SESSION_KEY)
    // Same: clicking + (new session) is a deliberate reset.
    setComposerDraft(null)
    // If we're not already in chat, snap back so the new-session hero
    // is what the user sees next.
    if (layout !== 'chat') onLayoutChange('chat')
    // Reveal the chat pane if a previous session collapsed it (see
    // onSelectSession for the asymmetric repro).
    expandSplit('notesci_split_chat')
  }
  const onLayoutChange = (m: LayoutMode) => {
    // Push `?layout=` into the URL so the browser back-button steps
    // through chat → reader → draft transitions instead of bypassing
    // the workspace entirely. localStorage is updated by the
    // URL-derived effect; chat is encoded as "no param" to keep the
    // address bar clean for the default mode.
    if (m === layout) return
    localStorage.setItem(LAYOUT_KEY, m)
    const next = new URLSearchParams(searchParams)
    if (m === 'chat') next.delete('layout')
    else next.set('layout', m)
    setSearchParams(next)
  }
  const onPickProject = (id: string) => {
    if (id === activeProjectId) return
    setActiveProjectId(id)
    localStorage.setItem(ACTIVE_PROJECT_KEY, id)
    // Switching projects invalidates the active session/material (they're
    // project-scoped). The effect-driven loaders will re-pull lists.
    setActiveSessionId(null)
    localStorage.removeItem(ACTIVE_SESSION_KEY)
    setActiveMaterialId(null)
    localStorage.removeItem(ACTIVE_MATERIAL_KEY)
    // A starter draft only makes sense in the project it was picked
    // for. Drop it on project switch.
    setComposerDraft(null)
  }
  const onNewProject = () => {
    setNewProjectOpen(true)
  }
  const createProject = async (name: string) => {
    try {
      const created = await api<ProjectOut>('/projects', {
        method: 'POST',
        auth: true,
        body: JSON.stringify({ name }),
      })
      setProjects((ps) => [created, ...ps])
      onPickProject(created.id)
      toast.success(`Created "${created.name}".`)
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't create that project."))
    }
  }
  const refreshMaterials = async () => {
    if (!activeProjectId) return
    try {
      const matRes = await api<
        {
          id: string
          project_id: string
          source_type: string
          title: string | null
          uri: string | null
          created_at: string
        }[]
      >(`/projects/${activeProjectId}/materials`, { auth: true })
        setMaterials(
          matRes.map((m) => ({
            id: m.id,
            title: m.title,
            source_type: m.source_type,
            uri: m.uri,
            created_at: m.created_at,
          })),
        )
      setMaterialsLoaded(true)
      // Notify the graph so the Map mode re-fetches /projects/{id}/map.
      window.dispatchEvent(new Event('notesci-materials-changed'))
    } catch {
      /* best effort */
    }
  }
  const onAskAboutPassage = (question: string) => {
    // Empty string = open the chat pane unchanged; only stamp a draft
    // when there's actually content to prefill.
    if (question.trim()) {
      setComposerDraft({ text: question, nonce: Date.now() })
    }
    onLayoutChange('chat')
  }

  // Permanent material deletion. The backend cascades chunks,
  // citations, ingestion jobs, concepts, and graph links via the FK
  // ON DELETE clauses, so we only need to fire the DELETE and refresh
  // the local list. If the deleted material is the currently-open
  // one in the Reader pane, drop it from active state so the Reader
  // falls back to its empty-state instead of 404-ing on the next fetch.
  const onDeleteMaterial = async (id: string, title: string | null) => {
    const label = (title ?? 'this material').trim() || 'this material'
    const ok = await confirm({
      title: `Delete "${label}"?`,
      description:
        'This removes the source, its embeddings, and any citations pointing at it. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await api(`/materials/${id}`, { method: 'DELETE', auth: true })
      // Drop any cached metadata, blob, or stitched content for this
      // id so a subsequent reader re-entry doesn't render the deleted
      // material from stale memory.
      invalidateMaterialCache(id)
      if (activeMaterialId === id) {
        setActiveMaterialId(null)
        localStorage.removeItem(ACTIVE_MATERIAL_KEY)
      }
      await refreshMaterials()
      toast.success(`Deleted "${label}".`)
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete that material."))
    }
  }

  // Rename a material. Optimistic — patch the local list immediately,
  // roll back + toast on failure. Once the backend confirms, dispatch
  // `notesci-materials-changed` so every other surface that displays
  // the material's title re-pulls fresh data:
  //   - GraphPane (Map / Citations / Concepts / Reasoning lenses) reads
  //     `/projects/:id/map` and `/sessions/:id/graph?mode=…` which
  //     embed the up-to-date title.
  //   - The chat history reloads via the ChatPane thread fetch when
  //     the user next opens a thread; existing in-memory bubbles keep
  //     their snapshot title (we don't rewrite history retroactively).
  //   - The reader pane re-reads the active material when materials
  //     change so its toolbar / metadata pane shows the new label.
  const onRenameMaterial = async (id: string, nextTitle: string) => {
    const prev = materials
    const trimmed = nextTitle.trim()
    const nextTitleOrNull = trimmed || null
    setMaterials((cur) =>
      cur.map((m) => (m.id === id ? { ...m, title: nextTitleOrNull } : m)),
    )
    try {
      await api(`/materials/${id}`, {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ title: trimmed }),
      })
      // Fan the change out to every other surface listening for
      // materials updates (GraphPane refetches its lens, ReaderPane
      // re-reads the active material's metadata). Same event the
      // ingestion + delete paths fire.
      window.dispatchEvent(new Event('notesci-materials-changed'))
    } catch (err) {
      setMaterials(prev)
      toast.error(errorMessage(err, "Couldn't rename that source."))
    }
  }

  // Rename a session. Optimistic — patch the local list immediately,
  // roll back + toast on failure. The backend trims + caps the title;
  // an empty string resets to NULL ("Untitled session").
  const onRenameSession = async (id: string, nextTitle: string) => {
    const prev = sessions
    const trimmed = nextTitle.trim()
    setSessions((cur) =>
      cur.map((s) =>
        s.id === id ? { ...s, title: trimmed || null } : s,
      ),
    )
    try {
      await api(`/sessions/${id}`, {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ title: trimmed }),
      })
    } catch (err) {
      setSessions(prev)
      toast.error(errorMessage(err, "Couldn't rename that session."))
    }
  }

  // Permanently delete a session. The backend cascades message
  // citations + chat_calls and best-effort-cleans the checkpointer
  // rows. If the deleted session is the active one, drop it so the
  // workspace falls back to the new-session landing.
  const onDeleteSession = async (id: string, title: string | null) => {
    const label = (title ?? 'this session').trim() || 'this session'
    const ok = await confirm({
      title: `Delete "${label}"?`,
      description:
        'This removes the conversation and its citations. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const prev = sessions
    setSessions((cur) => cur.filter((s) => s.id !== id))
    try {
      await api(`/sessions/${id}`, { method: 'DELETE', auth: true })
      if (activeSessionId === id) {
        setActiveSessionId(null)
        localStorage.removeItem(ACTIVE_SESSION_KEY)
        setComposerDraft(null)
      }
      toast.success(`Deleted "${label}".`)
    } catch (err) {
      setSessions(prev)
      toast.error(errorMessage(err, "Couldn't delete that session."))
    }
  }

  // Rename a project. Optimistic — patch the local list immediately,
  // roll back + toast on failure. The backend trims + caps the name
  // and rejects an empty one (name_required).
  const onRenameProject = async (id: string, nextName: string) => {
    const trimmed = nextName.trim()
    if (!trimmed) return
    const prev = projects
    setProjects((cur) =>
      cur.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
    )
    try {
      await api(`/projects/${id}`, {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ name: trimmed }),
      })
    } catch (err) {
      setProjects(prev)
      toast.error(errorMessage(err, "Couldn't rename that project."))
    }
  }

  // Permanently delete a project. The backend cascades sessions,
  // materials, drafts, workflows, ingestion jobs, and the material
  // graph tables, and scrubs the checkpointer rows. If the deleted
  // project is the active one, switch to the most-recent remaining
  // project — or, if it was the last one, clear active state so the
  // render falls back to the Welcome / new-project landing.
  const onDeleteProject = async (id: string) => {
    const proj = projects.find((p) => p.id === id)
    const label = (proj?.name ?? 'this project').trim() || 'this project'
    const ok = await confirm({
      title: `Delete "${label}"?`,
      description:
        'This removes the project and every session, material, and draft inside it. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const prev = projects
    const remaining = projects.filter((p) => p.id !== id)
    setProjects(remaining)
    try {
      await api(`/projects/${id}`, { method: 'DELETE', auth: true })
      if (activeProjectId === id) {
        if (remaining.length > 0) {
          onPickProject(remaining[0].id)
        } else {
          setActiveProjectId(null)
          localStorage.removeItem(ACTIVE_PROJECT_KEY)
          setActiveSessionId(null)
          localStorage.removeItem(ACTIVE_SESSION_KEY)
          setActiveMaterialId(null)
          localStorage.removeItem(ACTIVE_MATERIAL_KEY)
          setComposerDraft(null)
        }
      }
      toast.success(`Deleted "${label}".`)
    } catch (err) {
      setProjects(prev)
      toast.error(errorMessage(err, "Couldn't delete that project."))
    }
  }

  // Page-level material upload, for the empty-state "+ Upload materials"
  // button (the chat composer's paperclip handles the in-session case).
  const matUploadRef = useRef<HTMLInputElement | null>(null)
  const [matUploading, setMatUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // "Upload batch in progress" gate. When true, the center pane is
  // taken over by <UploadProgressView /> so the user has a single
  // dedicated spot to watch the pipeline instead of having to spot
  // the per-row strip in the sidebar. Set to true on every upload
  // path; only cleared once EVERY material in the batch has reached a
  // terminal stage (ready / failed). The user explicitly clicks
  // "Continue to workspace" to dismiss — we no longer auto-redirect,
  // because users found the implicit handoff disorienting (the page
  // would close itself just as the last source flipped to ready).
  const [uploadInProgress, setUploadInProgress] = useState(false)
  // Snapshot of every job started in the current batch. Required
  // because `ingestionTracker.jobs` prunes each entry ~1.8s after it
  // hits `ready` — without our own copy, the "3 of 5 ready" count
  // would shrink as completed jobs disappeared and the view would
  // flip to "1 of 1 ready" mid-batch (then auto-redirect, leaving the
  // user wondering what happened to the others). `batchJobs` keeps
  // the original count + the latest-known stage for every uploaded
  // material until the user dismisses the view.
  const [batchJobs, setBatchJobs] = useState<IngestionJob[]>([])
  // Pending /materials/ingest-pdf calls. Each upload site increments
  // before awaiting the API, decrements in the finally clause. Until
  // this is zero, the upload view treats the batch as "not yet
  // complete" — otherwise file #1 finishing its pipeline before file
  // #2 has even started uploading would flip the view to "1 of 1
  // ready" and the user could click Continue prematurely. With this
  // counter, the view shows the true denominator (jobs + pending)
  // and the Continue button stays disabled until every API call has
  // either produced a job row or failed.
  const [pendingUploads, setPendingUploads] = useState(0)
  const bumpPendingUploads = useCallback((delta: number) => {
    setPendingUploads((n) => Math.max(0, n + delta))
  }, [])
  const ingestionTracker = useIngestionTracker({
    // Once a job lands on 'ready', the material has been renamed and
    // its wiki links written — pull fresh titles + meta.
    onComplete: () => {
      void refreshMaterials()
    },
  })
  // Wrap startJob so every code path that triggers an upload also
  // raises the `uploadInProgress` gate AND seeds an entry in
  // `batchJobs` (so the view shows the row before the first poll).
  const startIngestionJob = useCallback(
    (input: { materialId: string; jobId: string | null; label: string }) => {
      setUploadInProgress(true)
      setBatchJobs((cur) =>
        cur.some((j) => j.materialId === input.materialId)
          ? cur
          : [
              ...cur,
              {
                materialId: input.materialId,
                jobId: input.jobId,
                label: input.label,
                stage: 'uploaded',
                progress: 0,
                note: null,
                errorMsg: null,
                startedAt: Date.now(),
              },
            ],
      )
      ingestionTracker.startJob(input)
    },
    [ingestionTracker],
  )
  // Sync the live stage / progress from the tracker into `batchJobs`.
  // The tracker prunes entries after they go ready; we hold onto the
  // last-known state for those so the count + per-source list stays
  // stable until the user explicitly continues.
  useEffect(() => {
    if (!uploadInProgress) return
    setBatchJobs((cur) =>
      cur.map((j) => {
        const live = ingestionTracker.jobsById.get(j.materialId)
        return live ? { ...j, ...live } : j
      }),
    )
  }, [ingestionTracker.jobsById, uploadInProgress])
  // Auto-dismiss the upload view if the active project changes (user
  // switched projects mid-batch, or deleted the project the batch
  // belonged to). Without this, deleting the project after the batch
  // finished left the user stranded on a "Continue to workspace" page
  // pointing at a project that no longer exists. The batch state is
  // tied to a specific project; on project change the view becomes
  // meaningless. The active-project ref tracks the *previous* id so
  // we only fire on actual changes, not the initial null→id load.
  const lastBatchProjectRef = useRef<string | null>(activeProjectId)
  useEffect(() => {
    if (lastBatchProjectRef.current !== activeProjectId) {
      lastBatchProjectRef.current = activeProjectId
      if (uploadInProgress) {
        setUploadInProgress(false)
      }
    }
  }, [activeProjectId, uploadInProgress])
  // Reset `batchJobs` once the user leaves the upload view so the next
  // batch starts from a clean slate. Pending-upload counter also resets
  // — in practice it should already be zero by the time the user
  // dismisses, but a defensive reset prevents a stuck count if an
  // upload promise was orphaned.
  useEffect(() => {
    if (!uploadInProgress) {
      setBatchJobs([])
      setPendingUploads(0)
    }
  }, [uploadInProgress])

  const onUploadMaterials = () => matUploadRef.current?.click()
  const resolveModelForRequest = useCallback(async (): Promise<string | null> => {
    const preferred = readPrefs().defaultModel
    const catalog = await getProviders().catch(() => null)
    return resolveUploadModel(preferred, catalog)
  }, [])
  const uploadPdfFile = async (f: File) => {
    if (!activeProjectId) return
    setMatUploading(true)
    // Raise the in-progress gate AND bump the pending counter so the
    // upload view's `allDone` stays false until this file's API
    // round-trip is over. Without the bump, a fast first file could
    // finish its whole pipeline before this second `apiForm` even
    // returns — the view would briefly read "1 of 1 ready" and the
    // user could click Continue early.
    setUploadInProgress(true)
    bumpPendingUploads(+1)
    try {
      const fd = new FormData()
      fd.append('project_id', activeProjectId)
      fd.append('file', f)
      const modelToSend = await resolveModelForRequest()
      if (modelToSend) {
        fd.append('model', modelToSend)
      }
      const ok = await apiForm<{
        material_id?: string
        job_id?: string | null
      }>('/materials/ingest-pdf', fd, { auth: true })
      if (ok?.material_id) {
        startIngestionJob({
          materialId: ok.material_id,
          jobId: ok.job_id ?? null,
          label: f.name,
        })
      }
      await refreshMaterials()
    } catch (err) {
      const e = err as ApiError
      const code = e.code
      toast.error(
        code === 'embedding_provider_unavailable'
          ? "Source indexing needs an embedding provider — add OpenAI, Google, or a custom embedding endpoint in Settings."
          : code === 'not_a_pdf'
            ? "That file isn't a PDF."
            : code === 'file_too_large'
              ? 'File is over 50 MB.'
              : code === 'empty_pdf'
                ? "We couldn't read any text from that PDF."
                : errorMessage(err, "Couldn't ingest that file."),
      )
    } finally {
      setMatUploading(false)
      bumpPendingUploads(-1)
    }
  }
  const onMatFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    e.target.value = ''
    // Raise the gate immediately so the upload view appears for the
    // whole batch — without this, the view only mounts when the FIRST
    // file's startIngestionJob runs, which can be seconds later for a
    // large file. uploadPdfFile re-raises it per file too (idempotent).
    setUploadInProgress(true)
    for (const f of files) {
      await uploadPdfFile(f)
    }
  }
  // Drag-and-drop PDF onto the workspace. Document-level so it works over
  // any pane. Only intercepts when there's an active project.
  useEffect(() => {
    if (!activeProjectId) return
    let dragCount = 0
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragCount++
      setDragOver(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault() // required for drop to fire
    }
    const onDragLeave = () => {
      dragCount = Math.max(0, dragCount - 1)
      if (dragCount === 0) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragCount = 0
      setDragOver(false)
      const all = Array.from(e.dataTransfer.files)
      if (all.length === 0) return
      // Filter to PDFs client-side so the server isn't hit for .docx etc.
      const pdfs = all.filter(
        (f) =>
          f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
      )
      const skipped = all.length - pdfs.length
      if (skipped > 0) {
        toast.warn(
          skipped === all.length
            ? "Only PDFs can be ingested right now."
            : `${skipped} non-PDF file${skipped === 1 ? '' : 's'} skipped.`,
        )
      }
      if (pdfs.length === 0) return
      // Sequential to avoid stampeding the backend's PDF parser. Each
      // upload toasts on its own success/failure.
      void (async () => {
        for (const f of pdfs) {
          await uploadPdfFile(f)
        }
      })()
    }
    // dragend covers the case where the user releases outside the
    // window or hits Escape — without it the overlay can get stuck.
    const onDragEnd = () => {
      dragCount = 0
      setDragOver(false)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])
  /** Save a chat reply as a fresh entry in the project's Draft library.
   *  Each call mints a new draft (per the Draft mode redesign) so users
   *  accumulate a collection of saved replies rather than overwriting a
   *  single document. Title auto-derived from the first line; body is
   *  the verbatim reply. Jumps to the Draft mode + opens the new
   *  entry so the user lands directly in the editor. */
  const onSendToDraft = async (text: string) => {
    if (!activeProjectId) {
      toast.warn('Pick a project before saving drafts.')
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return
    // First non-empty line, capped, used as the title.
    const firstLine = trimmed.split('\n').find((l) => l.trim()) ?? ''
    const title = (firstLine.length > 80 ? firstLine.slice(0, 79).trimEnd() + '…' : firstLine).trim()
    try {
      const created = await api<{ id: string }>(
        `/projects/${activeProjectId}/drafts`,
        {
          method: 'POST',
          auth: true,
          body: JSON.stringify({
            title: title || 'Saved from chat',
            body: trimmed,
          }),
        },
      )
      // Prime the "active draft" pointer so Draft mode opens the editor
      // directly on the freshly-saved entry.
      try {
        localStorage.setItem(
          `notesci_active_draft_${activeProjectId}`,
          created.id,
        )
      } catch {
        /* ignore */
      }
      toast.success('Saved to Draft.')
      onLayoutChange('draft')
    } catch {
      toast.error("Couldn't save to Draft — try again.")
    }
  }
  const onOpenReader = (materialId: string | null) => {
    if (materialId) {
      setActiveMaterialId(materialId)
      localStorage.setItem(ACTIVE_MATERIAL_KEY, materialId)
    } else {
      setActiveMaterialId(null)
      localStorage.removeItem(ACTIVE_MATERIAL_KEY)
    }
    onLayoutChange('reader')
  }
  // Citation chips in chat carry the chunk id alongside the material id.
  // We open the reader on that material, then set ``readerTarget`` so
  // ReaderPane can pulse + (in Slice C) scroll to the cited passage via
  // the upcoming PDF find feature. The bumping ``nonce`` lets us
  // re-trigger when the user clicks the same citation twice.
  const [readerTarget, setReaderTarget] = useState<{
    materialId: string
    chunkId: number
    nonce: number
  } | null>(null)
  const [externalSource, setExternalSource] = useState<{ url: string } | null>(null)
  const [externalAdding, setExternalAdding] = useState(false)
  const [externalPreview, setExternalPreview] = useState<{
    url: string
    title: string | null
    content: string
  } | null>(null)
  const [externalPreviewLoading, setExternalPreviewLoading] = useState(false)
  const [externalPreviewError, setExternalPreviewError] = useState<string | null>(null)
  const openExternalSource = useCallback((url: string) => {
    if (!isSafeHttpUrl(url)) return
    setExternalSource({ url })
  }, [])
  useEffect(() => {
    if (!externalSource) {
      setExternalPreview(null)
      setExternalPreviewError(null)
      setExternalPreviewLoading(false)
      return
    }
    const ac = new AbortController()
    setExternalPreview(null)
    setExternalPreviewError(null)
    setExternalPreviewLoading(true)
    void api<{ url: string; title: string | null; content: string }>(
      '/external/preview',
      {
        method: 'POST',
        auth: true,
        signal: ac.signal,
        body: JSON.stringify({ url: externalSource.url }),
      },
    )
      .then((preview) => {
        if (!ac.signal.aborted) setExternalPreview(preview)
      })
      .catch((err) => {
        if (!ac.signal.aborted) {
          setExternalPreviewError(errorMessage(err, "Couldn't open that external source."))
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setExternalPreviewLoading(false)
      })
    return () => ac.abort()
  }, [externalSource])
  // Add the reviewed source through the normal URL ingest path. The modal
  // intentionally avoids in-app live publisher pages because security checks
  // can stall inside embedded webviews; users can verify those pages in the
  // system browser before adding.
  const addExternalSourceToProject = useCallback(async () => {
    if (!externalSource || !activeProjectId) return
    setExternalAdding(true)
    try {
      const modelToSend = await resolveModelForRequest()
      const created = await api<{ material_id: string; job_id?: string | null }>(
        '/materials/ingest-url',
        {
          method: 'POST',
          auth: true,
          body: JSON.stringify({
            project_id: activeProjectId,
            url: externalSource.url,
            model: modelToSend,
          }),
        },
      )
      startIngestionJob({
        materialId: created.material_id,
        jobId: created.job_id ?? null,
        label: externalSource.url,
      })
      await refreshMaterials()
      toast.success('External source added to project.')
      setExternalSource(null)
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't add that external source."))
    } finally {
      setExternalAdding(false)
    }
  }, [activeProjectId, externalSource, refreshMaterials, resolveModelForRequest, startIngestionJob, toast])
  const onJumpToCitation = (detail: import('../lib/markdown').CitationClick) => {
    if (!isUuidLike(detail.materialId) && detail.materialUrl && isSafeHttpUrl(detail.materialUrl)) {
      openExternalSource(detail.materialUrl)
      return
    }
    if (!isUuidLike(detail.materialId)) {
      if (detail.materialUrl) {
        toast.warn("This citation points to a non-citable source. Open the link from the source list instead.")
      } else {
        toast.warn('This citation does not point to a stored material.')
      }
      return
    }
    setReaderTarget({
      materialId: detail.materialId,
      chunkId: detail.chunkId,
      nonce: Date.now(),
    })
    onOpenReader(detail.materialId)
  }

  const onThreadResolved = (id: string) => {
    // First send in a new ChatPane creates the backing session. Do not
    // call onSelectSession here: that changes the ChatPane key and
    // remounts it while the optimistic first user message + reply are
    // still in local state, making the first request appear to vanish.
    setActiveSessionId(id)
    localStorage.setItem(ACTIVE_SESSION_KEY, id)
    setComposerDraft(null)
    // refresh sessions list so the new one appears in the sidebar
    if (activeProjectId) {
      void (async () => {
        try {
          const sessRes = await api<
            { id: string; project_id: string; title: string | null; updated_at: string }[]
          >(`/projects/${activeProjectId}/sessions`, { auth: true })
          setSessions(
            sessRes.map((s) => ({
              id: s.id,
              title: s.title,
              updated_at: s.updated_at,
            })),
          )
        } catch {
          /* best effort */
        }
      })()
    }
  }

  const [paletteOpen, setPaletteOpen] = useCommandPalette()
  const paletteItems = useMemo(
    () =>
      buildDefaultItems({
        sessions,
        materials,
        navigate,
        onPickSession: onSelectSession,
        onPickMaterial: (id) => onOpenReader(id),
        onNewSession,
        onLayout: onLayoutChange,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, materials, navigate],
  )

  const initials = useMemo(
    () => initialsFor(me?.display_name ?? null, me?.email ?? null),
    [me],
  )

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--color-paper)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--color-rule)',
            background: '#fff',
          }}
        >
          <Lockup variant="split" size={20} />
        </header>
        <main
          id="main"
          role="alert"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            gap: 16,
            textAlign: 'center',
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.1em',
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
            }}
          >
            COULDN'T LOAD WORKSPACE
          </div>
          <h1
            className="font-serif"
            style={{
              fontSize: 32,
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              margin: 0,
              fontWeight: 500,
              color: 'var(--color-ink)',
            }}
          >
            Something's off.
          </h1>
          <p style={{ color: 'var(--color-ink-2)', fontSize: 14, maxWidth: 420 }}>
            {error}
          </p>
          <div role="toolbar" aria-label="Recovery actions" style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="ns-btn ghost"
              onClick={() => window.location.reload()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Icons.reset size={12} />
              Reload
            </button>
          </div>
        </main>
      </div>
    )
  }

  if (!me) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--color-paper)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--color-rule)',
            background: '#fff',
          }}
        >
          <Lockup variant="split" size={20} />
        </header>
        <main
          id="main"
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-muted)',
            gap: 10,
          }}
          aria-live="polite"
          aria-busy
        >
          <span className="spinner" aria-hidden />
          <span style={{ fontSize: 13 }}>Loading workspace…</span>
        </main>
      </div>
    )
  }

  // No projects → first-run "Welcome" empty state.
  if (projects.length === 0 || !activeProject) {
    return (
      <>
        <div
          style={{
            height: '100vh',
            background: 'var(--color-paper)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <header
            style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--color-rule)',
              background: '#fff',
            }}
          >
            <Lockup variant="split" size={20} />
          </header>
          <main id="main" style={{ flex: 1, display: 'flex' }}>
            <EmptyCard
              kind={`WELCOME, ${(
                me.display_name ?? me.email.split('@')[0] ?? me.email
              ).toUpperCase()}`}
              title="Start your first project."
              desc="A project is a topic you're researching. Each holds its materials, sessions, and graph — separate from the rest, so notesci stays grounded."
              primary={{
                label: '+ New project',
                onClick: () => setNewProjectOpen(true),
              }}
              illus={<ProjectsIllus />}
            />
          </main>
        </div>
        {newProjectOpen && (
          <TextPromptModal
            title="Name your first project"
            description="A project bundles your sources, sessions, and drafts on one topic."
            label="Project name"
            placeholder="e.g. Working memory benchmarks"
            submitLabel="Create project"
            onSubmit={(name) => void createProject(name)}
            onClose={() => setNewProjectOpen(false)}
          />
        )}
      </>
    )
  }

  const center = (() => {
    // Active upload batch: take over the center pane with a single
    // aggregated progress view until every job in the batch reaches a
    // terminal stage. The view reads from `batchJobs` (our local
    // snapshot) instead of `ingestionTracker.jobs` so completed
    // sources don't disappear from the count as the tracker prunes
    // them — the user always sees the full "N of N" denominator they
    // uploaded with. `autoContinue` is OFF: even after every source
    // is ready, the user explicitly clicks "Continue to workspace"
    // so we never silently drop them onto the main page mid-glance.
    if (uploadInProgress && batchJobs.length > 0) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            padding: 12,
            minWidth: 0,
          }}
        >
          <UploadProgressView
            jobs={batchJobs}
            pendingUploads={pendingUploads}
            onContinue={() => setUploadInProgress(false)}
          />
        </div>
      )
    }
    // No materials in project → empty-materials state regardless of layout.
    // (Otherwise Reading/Drafting modes would render their panes pointing
    // at nothing; better to nudge the user to upload.) Gate on
    // `materialsLoaded` so we don't flash the empty state before the
    // initial fetch resolves on projects that *do* have materials.
    if (materialsLoaded && materials.length === 0) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            padding: 12,
            minWidth: 0,
          }}
        >
          <div className="pane" style={{ flex: 1, display: 'flex' }}>
            <EmptyCard
              kind="THIS PROJECT IS EMPTY"
              title="Drop a few PDFs to start a session."
              desc="notesci needs at least one source to ground its answers. Anything goes — papers, notes, web articles, recorded talks."
              primary={{
                label: matUploading ? 'Uploading…' : '+ Upload materials',
                onClick: onUploadMaterials,
                busy: matUploading,
              }}
              illus={<MaterialsIllus />}
            />
          </div>
        </div>
      )
    }
    // Reading mode: reader + graph (draggable split)
    if (layout === 'reader') {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            padding: 12,
            minWidth: 0,
          }}
        >
          <ResizableSplit
            // Each ResizableSplit in the workspace gets a unique key so
            // React does NOT reuse the same fiber across layout
            // transitions. Without the key, switching from reader →
            // chat reuses the reader's ResizableSplit fiber (same
            // type, same JSX position) and carries its
            // `collapsed='first'` state over into the chat split,
            // which then mounts with the chat pane hidden. See the
            // bug repro in repro_actual.mjs for the symptom.
            key="rs-reader"
            direction="vertical"
            storageKey="notesci_split_reader"
            defaultRatio={0.6}
            min={0.3}
            max={0.8}
            ariaLabel="Resize reader and graph panes"
            collapsible="both"
            firstLabel="reader"
            secondLabel="graph"
            first={
              <ReaderPane
                projectId={activeProjectId!}
                workspaceId={me?.workspace_id ?? null}
                materialId={
                  (activeMaterialId &&
                    materials.find((m) => m.id === activeMaterialId)?.id) ||
                  materials[0]?.id ||
                  null
                }
                onAskAboutPassage={onAskAboutPassage}
                citationTarget={
                  readerTarget &&
                  readerTarget.materialId === activeMaterialId
                    ? readerTarget
                    : null
                }
              />
            }
            second={
              <PaneErrorBoundary paneName="graph">
                <GraphPane
                  sessionId={activeSessionId}
                  projectId={activeProjectId}
                  mode={graphMode}
                  onModeChange={setAndPersistGraphMode}
                />
              </PaneErrorBoundary>
            }
          />
        </div>
      )
    }

    // Draft mode: drafter only (no chat). Acts as the per-project
    // drafts library where chat-generated finals are saved.
    // Wrapper has `display: flex; flex: 1` and a width-stretching
    // inner flex item so the pane (which has no flex sizing of its
    // own — `.pane` is `display: flex` but not `flex: 1`) actually
    // fills the workspace center column instead of shrinking to its
    // content.
    if (layout === 'draft') {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            padding: 12,
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <DrafterPane projectId={activeProjectId} />
          </div>
        </div>
      )
    }

    // No active session AND no pre-filled draft → premium "new session"
    // landing. Starter cards (not chips) sit above an inline composer;
    // the project's materials Map renders below in the same horizontal
    // split as the active Default layout, so users have a visual
    // anchor while they decide what to ask.
    if (!activeSessionId && !composerDraft) {
      const launchStarter = (prompt: string) => {
        setActiveSessionId(null)
        localStorage.removeItem(ACTIVE_SESSION_KEY)
        // Pre-fill the composer AND auto-send: when the user hits
        // Enter / Send in the hero they expect their message to go to
        // the model, not to be merely staged into the next pane.
        // ChatPane picks the `autoSend` flag up off `initialDraft` and
        // fires its own submit() on mount.
        setComposerDraft({ text: prompt, nonce: Date.now(), autoSend: true })
        onLayoutChange('chat')
      }
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            padding: 12,
            minWidth: 0,
          }}
        >
          <ResizableSplit
            key="rs-hero"
            direction="horizontal"
            storageKey="notesci_split_chat"
            defaultRatio={0.6}
            min={0.3}
            max={0.8}
            ariaLabel="Resize landing and graph panes"
            collapsible="both"
            firstLabel="landing"
            secondLabel="graph"
            first={
              <DefaultEmptyHero
                materials={materials}
                onLaunch={launchStarter}
                projectId={activeProjectId}
                onMaterialIngested={refreshMaterials}
                onIngestionStarted={startIngestionJob}
                onUploadAttempt={bumpPendingUploads}
              />
            }
            second={
              <PaneErrorBoundary paneName="graph">
                <GraphPane
                  sessionId={activeSessionId}
                  projectId={activeProjectId}
                  mode={graphMode}
                  onModeChange={setAndPersistGraphMode}
                />
              </PaneErrorBoundary>
            }
          />
        </div>
      )
    }

    // Default mode: chat (top) + graph (bottom), draggable split
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          padding: 12,
          minWidth: 0,
        }}
      >
        <ResizableSplit
          key="rs-chat"
          direction="horizontal"
          storageKey="notesci_split_chat"
          defaultRatio={0.6}
          min={0.3}
          max={0.8}
          ariaLabel="Resize chat and graph panes"
          collapsible="both"
          firstLabel="chat"
          secondLabel="graph"
          first={
            <PaneErrorBoundary paneName="chat">
              <ChatPane
                threadId={activeSessionId}
                projectId={activeProjectId}
                projectName={activeProject.name}
                materials={materials}
                onThreadResolved={onThreadResolved}
                onOpenReader={onOpenReader}
                onJumpToCitation={onJumpToCitation}
                onOpenExternalSource={openExternalSource}
                onSendToDraft={onSendToDraft}
                onMaterialIngested={refreshMaterials}
                onIngestionStarted={startIngestionJob}
                onUploadAttempt={bumpPendingUploads}
                initialDraft={composerDraft?.text}
                initialAutoSend={composerDraft?.autoSend ?? false}
                key={`default-${activeProjectId ?? 'none'}`}
              />
            </PaneErrorBoundary>
          }
          second={
            <PaneErrorBoundary paneName="graph">
              <GraphPane
                sessionId={activeSessionId}
                projectId={activeProjectId}
                mode={graphMode}
                onModeChange={setAndPersistGraphMode}
              />
            </PaneErrorBoundary>
          }
        />
      </div>
    )
  })()

  return (
    <>
      <SmallScreenNotice where="workspace" />
      <div
        className="hide-on-small"
        style={{
          height: '100vh',
          // Transparent so the body's brand wash refracts through the
          // glass chrome (TopBar, sidebars, composer dock). The pane
          // class still paints #fff inside each surface so reading
          // legibility for messages / reader / drafter is unaffected.
          background: 'transparent',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
      <TopBar
        projectName={activeProject.name}
        activeProjectId={activeProjectId}
        projects={projects}
        onPickProject={onPickProject}
        onNewProject={onNewProject}
        onRenameProject={onRenameProject}
        onDeleteProject={onDeleteProject}
        layout={layout}
        onLayout={onLayoutChange}
        onClickNewSession={onNewSession}
        onClickSearch={() => setPaletteOpen(true)}
        initials={initials}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />
      <main id="main" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Visually-hidden h1 anchors the heading hierarchy: panes use
            h2, so AT users browsing by heading start here on the
            workspace. */}
        <h1 className="sr-only">
          Workspace · {activeProject.name}
        </h1>
        {sideOpen ? (
          <>
            <SidePanel
              projectName={activeProject.name}
              sessions={sessions}
              materials={materials}
              activeSessionId={activeSessionId}
              activeMaterialId={activeMaterialId}
              onSelectSession={onSelectSession}
              onSelectMaterial={(id) => onOpenReader(id)}
              onRenameMaterial={onRenameMaterial}
              onDeleteMaterial={onDeleteMaterial}
              onRenameSession={onRenameSession}
              onDeleteSession={onDeleteSession}
              onNewSession={onNewSession}
              onNewProject={onNewProject}
              onAddSource={onUploadMaterials}
              ingestingIds={ingestionTracker.activeIds}
              ingestionJobs={ingestionTracker.jobsById}
              width={280}
              onCollapse={() => {
                setSideOpen(false)
                localStorage.setItem(SIDE_OPEN_KEY, '0')
              }}
            />
            <div className="splitter-v" aria-hidden />
          </>
        ) : (
          <>
            {/* Collapsed rail — single button reveals the panel. Same
                SidebarGlyph icon + same position (next to the panel
                area) as the General page uses. */}
            <aside
              className="ns-glass-chrome"
              aria-label="Sidebar collapsed"
              style={{
                width: 44,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                padding: '12px 0',
                borderRight: '1px solid var(--color-glass-border-soft)',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setSideOpen(true)
                  localStorage.setItem(SIDE_OPEN_KEY, '1')
                }}
                aria-label="Show sidebar"
                aria-keyshortcuts="Meta+\\ Control+\\"
                title="Show sidebar (⌘\)"
                style={{
                  width: 30,
                  height: 30,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-ink-2)',
                  cursor: 'pointer',
                }}
              >
                <SidebarGlyph open={false} />
              </button>
            </aside>
          </>
        )}
        {center}
      </main>
      </div>
      {newProjectOpen && (
        <TextPromptModal
          title="New project"
          description="Projects bundle materials, sessions, and drafts together."
          label="Project name"
          placeholder="e.g. Working memory benchmarks"
          submitLabel="Create project"
          onSubmit={(name) => void createProject(name)}
          onClose={() => setNewProjectOpen(false)}
        />
      )}
      {externalSource && (
        <Modal
          title="External source"
          description="Review this source before deciding whether to add it to the project."
          onClose={() => setExternalSource(null)}
          width={980}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--color-muted)',
                  fontSize: 13,
                }}
                title={externalSource.url}
              >
                {externalSource.url}
              </div>
              <button
                type="button"
                className="ns-btn ghost"
                style={{ minWidth: 170, justifyContent: 'center', flexShrink: 0 }}
                onClick={() => openInSystemBrowser(externalSource.url)}
              >
                Open in browser
              </button>
              <button
                type="button"
                className="ns-btn"
                style={{ minWidth: 170, justifyContent: 'center', flexShrink: 0 }}
                disabled={!activeProjectId || externalAdding}
                onClick={() => void addExternalSourceToProject()}
              >
                {externalAdding ? 'Adding…' : 'Add to project sources'}
              </button>
            </div>
            <div
              style={{
                height: 'min(68vh, 720px)',
                border: '1px solid var(--color-rule)',
                borderRadius: 12,
                overflow: 'auto',
                background: '#fff',
                padding: 20,
              }}
            >
              {externalPreviewLoading ? (
                <div style={{ color: 'var(--color-muted)', fontSize: 13 }}>
                  Fetching readable web content…
                </div>
              ) : externalPreviewError ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 14,
                    height: '100%',
                    textAlign: 'center',
                    padding: 24,
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-serif), Georgia, serif',
                      fontSize: 19,
                      color: 'var(--color-ink)',
                    }}
                  >
                    Can’t summarise this source here.
                  </div>
                  <div
                    style={{
                      color: 'var(--color-muted)',
                      fontSize: 13,
                      lineHeight: 1.6,
                      maxWidth: 480,
                    }}
                  >
                    This publisher blocks automated fetching, so Notesci can’t
                    show a readable extract here. Use “Open in browser” to
                    review the source directly, then add it if it is the right
                    item.
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                    <button
                      type="button"
                      className="ns-btn"
                      onClick={() => openInSystemBrowser(externalSource.url)}
                    >
                      Open in browser
                    </button>
                  </div>
                </div>
              ) : externalPreview ? (
                <article style={{ maxWidth: 820, margin: '0 auto' }}>
                  <h3
                    style={{
                      margin: 0,
                      marginBottom: 12,
                      fontFamily: 'var(--font-serif), Georgia, serif',
                      fontSize: 24,
                      lineHeight: 1.2,
                    }}
                  >
                    {externalPreview.title || 'External source'}
                  </h3>
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'var(--font-serif), Georgia, serif',
                      fontSize: 15,
                      lineHeight: 1.7,
                      color: 'var(--color-ink)',
                    }}
                  >
                    {externalPreview.content}
                  </pre>
                  <div
                    style={{
                      marginTop: 18,
                      paddingTop: 14,
                      borderTop: '1px solid var(--color-rule)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 12.5, color: 'var(--color-muted)' }}>
                      Readable extract. Open in browser for figures and layout.
                    </span>
                    <button
                      type="button"
                      className="ns-btn ghost"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => openInSystemBrowser(externalSource.url)}
                    >
                      Open in browser
                    </button>
                  </div>
                </article>
              ) : null}
            </div>
          </div>
        </Modal>
      )}
      {confirmDialog}
      <input
        ref={matUploadRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        style={{ display: 'none' }}
        onChange={onMatFilePicked}
      />
      {/* Hide the floating pill while the full-pane "Digesting" view
          owns the workspace — there's no point showing two progress
          UIs for the same batch. The pill stays visible for jobs that
          continue indexing in the background after the user clicks
          "Continue anyway". */}
      {!uploadInProgress && (
        <IngestionStrip
          jobs={ingestionTracker.jobs}
          onDismiss={ingestionTracker.dismissJob}
        />
      )}
      {dragOver && (
        <div
          aria-live="polite"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'color-mix(in oklch, var(--color-indigo) 22%, transparent)',
            border: '3px dashed var(--color-indigo)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 250,
            pointerEvents: 'none',
          }}
        >
          <div
            className="font-serif"
            style={{
              padding: '20px 28px',
              background: '#fff',
              borderRadius: 14,
              boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
              fontSize: 22,
              color: 'var(--color-ink)',
              fontWeight: 500,
            }}
          >
            Drop PDFs to add them to{' '}
            <em style={{ color: 'var(--color-indigo)' }}>
              {activeProject?.name ?? 'this project'}
            </em>
          </div>
        </div>
      )}
    </>
  )
}
