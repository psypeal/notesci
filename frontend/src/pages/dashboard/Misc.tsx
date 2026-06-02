import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { LRow, PageHeader, PageScaffold, SectionCard } from '../../components/dashboard/PageScaffold'
import { Icons } from '../../components/icons'
import { api, apiBlob, errorMessage } from '../../lib/api'
import { useMe, userCard } from './useMe'
import { useConfirm } from '../../lib/useConfirm'
import { useToast } from '../../components/Toast'
import { Modal } from '../../components/Modal'
import { DEFAULT_PREFS, PREFS_KEY, type PrefsState } from '../../lib/prefs'
import {
  getProviders,
  peekProviders,
  refreshProviders,
  subscribeProviders,
  type ProvidersAvailable,
} from '../../lib/models'
import { relativeTime } from '../../lib/relative-time'

/* -------------------- Preferences (local-only) -------------------- */

export function PreferencesPage() {
  const { me } = useMe()
  const [prefs, setPrefs] = useState<PrefsState>(() => {
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
    } catch {
      return DEFAULT_PREFS
    }
  })
  const [catalog, setCatalog] = useState<ProvidersAvailable | null>(() =>
    peekProviders(),
  )
  useEffect(() => {
    let alive = true
    void getProviders()
      .then((c) => {
        if (alive) setCatalog(c)
      })
      .catch(() => {
        /* offline / 401 — fall back to disabled controls */
      })
    return subscribeProviders((c) => {
      if (alive) setCatalog(c)
    })
  }, [])

  const update = <K extends keyof PrefsState>(k: K, v: PrefsState[K]) => {
    const next = { ...prefs, [k]: v }
    setPrefs(next)
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    // Broadcast so App.tsx re-applies theme / density data-attrs without
    // requiring a page refresh.
    window.dispatchEvent(new Event('notesci-prefs-changed'))
  }

  // Detect that the saved preference points to a model that's no longer
  // available (operator unset the provider key). Surface a banner so the
  // user knows what's happening — chats still work via the server fallback,
  // but the pill in the workspace will show "default" instead of their pick.
  const savedModelInfo = catalog?.models.find((m) => m.id === prefs.defaultModel)
  const savedModelUnavailable = !!prefs.defaultModel && !!catalog && !savedModelInfo?.available
  // notesci does NOT impose a default model. When the user hasn't picked,
  // the server falls through to the first available provider. We surface
  // this clearly so the user knows they can (and should) make the call.
  const userHasPicked = !!prefs.defaultModel && !savedModelUnavailable
  const fallbackLabel = catalog?.fallback_model
    ? catalog.models.find((m) => m.id === catalog.fallback_model)?.label ??
      catalog.fallback_model
    : null
  return (
    <PageScaffold
      active="preferences"
      crumbs={['Settings', 'General', 'Preferences']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="GENERAL"
        title="Preferences"
        desc="Defaults for new chats, the workspace shell, and the graph pane. Stored locally — applies on this device only."
      />
      <SectionCard title="Agent">
        <LRow
          label="DEFAULT MODEL"
          value={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Status card — explicit signal about what's active and why.
                  Indigo when the user picked; muted when they haven't. */}
              <div
                role="status"
                style={{
                  fontSize: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: userHasPicked
                    ? 'color-mix(in oklch, var(--color-indigo, #524ec7) 8%, transparent)'
                    : 'var(--color-paper-2, #f3efe6)',
                  border: '1px solid',
                  borderColor: userHasPicked
                    ? 'color-mix(in oklch, var(--color-indigo, #524ec7) 30%, transparent)'
                    : 'var(--color-rule, rgba(0,0,0,0.08))',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  lineHeight: 1.45,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: userHasPicked
                      ? 'var(--color-indigo, #524ec7)'
                      : 'var(--color-muted, #837866)',
                    flexShrink: 0,
                  }}
                />
                <span>
                  {userHasPicked ? (
                    <>
                      Your chats use{' '}
                      <strong style={{ fontWeight: 600 }}>
                        {savedModelInfo?.label ?? prefs.defaultModel}
                      </strong>
                      .
                    </>
                  ) : (
                    <>
                      No default picked — your chats run on{' '}
                      <strong style={{ fontWeight: 600 }}>
                        {fallbackLabel ?? 'whichever provider is configured'}
                      </strong>
                      . Pick one below to lock it in.
                    </>
                  )}
                </span>
              </div>

              <select
                className="ns-input"
                value={prefs.defaultModel ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  update('defaultModel', v === '' ? null : v)
                }}
                aria-label="Default model for new chats"
              >
                <option value="">
                  No preference
                  {fallbackLabel ? ` — uses ${fallbackLabel}` : ''}
                </option>
                {catalog?.providers.map((p) => {
                  const provModels = catalog.models.filter((m) => m.provider_id === p.id)
                  if (provModels.length === 0) return null
                  return (
                    <optgroup key={p.id} label={p.display_name}>
                      {provModels.map((m) => (
                        <option key={m.id} value={m.id} disabled={!m.available}>
                          {m.label}
                          {m.kind === 'reasoning' ? ' · reasoning' : ''}
                        </option>
                      ))}
                    </optgroup>
                  )
                })}
              </select>
              {savedModelUnavailable && (
                <div
                  role="status"
                  style={{
                    fontSize: 11.5,
                    padding: '6px 10px',
                    borderRadius: 6,
                    background:
                      'color-mix(in oklch, var(--color-warn, #c98a17) 12%, transparent)',
                    color: 'var(--color-warn, #b06800)',
                  }}
                >
                  Your saved model is unavailable. New chats use{' '}
                  {fallbackLabel ?? 'the first available provider'} until you pick another.
                </div>
              )}
            </div>
          }
          help="Pick the model you want notesci to use by default. Greyed-out options aren't available — their provider key isn't configured."
        />
        <LRow
          label="DEFAULT STYLE"
          value={
            <div style={{ display: 'flex', gap: 6 }}>
              {(['fast', 'balanced', 'thorough'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`tag ${prefs.defaultStyle === s ? 'solid' : ''}`}
                  style={{ cursor: 'pointer', fontSize: 11.5 }}
                  onClick={() => update('defaultStyle', s)}
                  aria-pressed={prefs.defaultStyle === s}
                >
                  {s}
                </button>
              ))}
            </div>
          }
        />
      </SectionCard>
      <SectionCard title="Workspace">
        <LRow
          label="GRAPH DEFAULT"
          value={
            <div style={{ display: 'flex', gap: 6 }}>
              {(['citations', 'concepts', 'reasoning'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`tag ${prefs.graphMode === m ? 'solid' : ''}`}
                  style={{ cursor: 'pointer', fontSize: 11.5 }}
                  onClick={() => update('graphMode', m)}
                  aria-pressed={prefs.graphMode === m}
                >
                  {m}
                </button>
              ))}
            </div>
          }
        />
        <LRow
          label="DENSITY"
          value={
            <div style={{ display: 'flex', gap: 6 }}>
              {(['comfortable', 'compact'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`tag ${prefs.density === d ? 'solid' : ''}`}
                  style={{ cursor: 'pointer', fontSize: 11.5 }}
                  onClick={() => update('density', d)}
                  aria-pressed={prefs.density === d}
                >
                  {d}
                </button>
              ))}
            </div>
          }
        />
        <LRow
          label="THEME"
          value={
            <div style={{ display: 'flex', gap: 6 }}>
              {(['paper', 'plain'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`tag ${prefs.theme === t ? 'solid' : ''}`}
                  style={{ cursor: 'pointer', fontSize: 11.5 }}
                  onClick={() => update('theme', t)}
                  aria-pressed={prefs.theme === t}
                >
                  {t}
                </button>
              ))}
            </div>
          }
        />
      </SectionCard>
    </PageScaffold>
  )
}

/* -------------------- Profile -------------------- */

function ProfileField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 18px',
        borderTop: '1px solid var(--color-rule)',
      }}
    >
      <label
        className="font-mono"
        style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-muted)' }}
      >
        {label.toUpperCase()}
      </label>
      <input
        className="ns-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        style={{ width: '100%', maxWidth: 440 }}
        aria-label={label}
      />
    </div>
  )
}

export function ProfilePage() {
  const { me, refresh } = useMe()
  const toast = useToast()
  const [name, setName] = useState('')
  const [affiliation, setAffiliation] = useState('')
  const [orcid, setOrcid] = useState('')
  const [field, setField] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  // Seed the form once /me lands; after that the inputs are the source
  // of truth so re-renders don't clobber what the user is typing.
  useEffect(() => {
    if (me && !hydrated) {
      setName(me.display_name ?? '')
      setAffiliation(me.affiliation ?? '')
      setOrcid(me.orcid ?? '')
      setField(me.field_of_research ?? '')
      setHydrated(true)
    }
  }, [me, hydrated])
  const norm = (s: string) => s.trim()
  const dirty =
    hydrated &&
    (norm(name) !== (me?.display_name ?? '') ||
      norm(affiliation) !== (me?.affiliation ?? '') ||
      norm(orcid) !== (me?.orcid ?? '') ||
      norm(field) !== (me?.field_of_research ?? ''))
  const save = async () => {
    setSaving(true)
    try {
      await api('/me', {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({
          display_name: norm(name) || null,
          affiliation: norm(affiliation) || null,
          orcid: norm(orcid) || null,
          field_of_research: norm(field) || null,
        }),
      })
      toast.success('Profile updated.')
      refresh()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save your profile."))
    } finally {
      setSaving(false)
    }
  }
  return (
    <PageScaffold
      active="profile"
      crumbs={['Settings', 'General', 'Profile']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="GENERAL"
        title="Profile"
        desc="Your display name and research identity. notesci runs locally — there’s no sign-up and no email to verify; pick whatever name you like."
      />
      <SectionCard
        title="Display name"
        desc="Shown across notesci and used to sign your drafts."
      >
        <div style={{ padding: '4px 18px 18px' }}>
          <input
            className="ns-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ada Lovelace"
            maxLength={200}
            style={{ width: '100%', maxWidth: 440 }}
            aria-label="Display name"
          />
        </div>
      </SectionCard>
      <SectionCard
        title="Research identity"
        desc="Optional — helps the agent attribute work and format citations."
      >
        <ProfileField
          label="Affiliation"
          value={affiliation}
          onChange={setAffiliation}
          placeholder="University / lab / company"
          maxLength={200}
        />
        <ProfileField
          label="ORCID"
          value={orcid}
          onChange={setOrcid}
          placeholder="0000-0000-0000-0000"
          maxLength={64}
        />
        <ProfileField
          label="Field of research"
          value={field}
          onChange={setField}
          placeholder="e.g. Computational neuroscience"
          maxLength={200}
        />
      </SectionCard>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button
          type="button"
          className="ns-btn"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </PageScaffold>
  )
}

/* -------------------- Notifications (local-only) -------------------- */

const NOTIF_KEY = 'notesci_notifs'

export function NotificationsPage() {
  const { me } = useMe()
  type Notif = { mcpFailures: boolean; ingestDone: boolean }
  const [n, setN] = useState<Notif>(() => {
    try {
      return { mcpFailures: true, ingestDone: true, ...JSON.parse(localStorage.getItem(NOTIF_KEY) ?? '{}') }
    } catch {
      return { mcpFailures: true, ingestDone: true }
    }
  })
  const set = (k: keyof Notif, v: boolean) => {
    const next = { ...n, [k]: v }
    setN(next)
    localStorage.setItem(NOTIF_KEY, JSON.stringify(next))
  }
  return (
    <PageScaffold
      active="notifications"
      crumbs={['Settings', 'General', 'Notifications']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="GENERAL"
        title="Notifications"
        desc="In-app notices that surface while you work. notesci runs entirely on this device — there’s no email or external delivery to configure."
      />
      <SectionCard
        title="In-app alerts"
        desc="Shown as a toast or workspace banner, never sent anywhere."
      >
        <Toggle
          label="MCP server failures"
          help="Flag when an installed MCP server’s health check fails."
          value={n.mcpFailures}
          onChange={(v) => set('mcpFailures', v)}
        />
        <Toggle
          label="Indexing finished"
          help="Let me know when a source finishes ingesting into a project."
          value={n.ingestDone}
          onChange={(v) => set('ingestDone', v)}
        />
      </SectionCard>
    </PageScaffold>
  )
}

function Toggle({
  label,
  help,
  value,
  onChange,
}: {
  label: string
  help?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <LRow
      label={label.toUpperCase()}
      value={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
          }}
          onClick={() => onChange(!value)}
        >
          <button
            type="button"
            role="switch"
            aria-checked={value}
            aria-label={label}
            onClick={(e) => {
              // Outer wrapper handles the toggle; stop propagation so we
              // don't double-flip when the user clicks the switch itself.
              e.stopPropagation()
              onChange(!value)
            }}
            style={{
              width: 36,
              height: 20,
              borderRadius: 12,
              background: value ? 'var(--color-indigo)' : 'var(--color-rule-2)',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              padding: 0,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: value ? 18 : 2,
                width: 16,
                height: 16,
                borderRadius: 8,
                background: '#fff',
                transition: 'left 0.15s',
              }}
            />
          </button>
          <span style={{ fontSize: 13, userSelect: 'none' }}>{label}</span>
        </div>
      }
      help={help}
    />
  )
}

/* -------------------- Sources (real MCP-backed connectors) -------------------- */

interface CatalogEntry {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  available: boolean
  show_in_sources: boolean
  source_fields: SourceField[]
  launcher: string | null
}

interface SourceField {
  label: string
  path: string
  placeholder: string | null
  secret: boolean
  help_url: string | null
}

interface InstalledServer {
  id: string
  slug: string
  name: string
  transport: string
  config: Record<string, unknown>
  enabled: boolean
}

interface SystemTools {
  uvx: boolean
  npx: boolean
  uv: boolean
}

function getByPath(root: Record<string, unknown> | undefined, path: string): unknown {
  let cursor: unknown = root
  for (const k of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(k in (cursor as Record<string, unknown>))) {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[k]
  }
  return cursor
}

/** Drill a dotted path (e.g. ``env.ZOTERO_API_KEY``) into a config blob,
 * creating intermediate objects as needed. Mutates and returns the root. */
function setByPath(root: Record<string, unknown>, path: string, value: string): Record<string, unknown> {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = root
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (!(k in cursor) || typeof cursor[k] !== 'object' || cursor[k] === null) {
      cursor[k] = {}
    }
    cursor = cursor[k] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
  return root
}

export function SourcesPage() {
  const { me } = useMe()
  const toast = useToast()
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [installed, setInstalled] = useState<InstalledServer[] | null>(null)
  const [tools, setTools] = useState<SystemTools | null>(null)
  const [editing, setEditing] = useState<
    { entry: CatalogEntry; installedId: string | null } | null
  >(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    void (async () => {
      try {
        const [c, s, t] = await Promise.all([
          api<CatalogEntry[]>('/mcp/catalog', { auth: true }),
          api<InstalledServer[]>('/mcp/servers', { auth: true }),
          api<SystemTools>('/system/tools', { auth: true }),
        ])
        setCatalog(c)
        setInstalled(s)
        setTools(t)
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't load connectors."))
        setCatalog([])
        setInstalled([])
        setTools({ uvx: false, npx: false, uv: false })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick])

  const findInstalled = (catalogId: string): InstalledServer | undefined =>
    installed?.find((s) => s.slug === catalogId)

  const onDisconnect = async (server: InstalledServer) => {
    setBusy(server.id)
    try {
      await api(`/mcp/servers/${server.id}`, { method: 'DELETE', auth: true })
      toast.success(`Disconnected ${server.name}.`)
      setReloadTick((t) => t + 1)
    } catch (err) {
      toast.error(errorMessage(err, `Couldn't disconnect ${server.name}.`))
    } finally {
      setBusy(null)
    }
  }

  const filteredCatalog =
    catalog
      ?.filter((e) => e.show_in_sources)
      .sort((a, b) => a.name.localeCompare(b.name)) ?? []
  const isAdmin = me?.role === 'admin'

  const isBlockedByLauncher = (entry: CatalogEntry): { blocked: boolean; reason?: string } => {
    if (!tools) {
      return { blocked: false }
    }
    if (entry.transport !== 'stdio') {
      return { blocked: false }
    }
    if (!entry.launcher) {
      return { blocked: false, reason: 'Launcher not detected for this connector.' }
    }
    if (entry.launcher === 'npx') {
      return {
        blocked: !tools.npx,
        reason: !tools.npx ? 'Install Node.js/npm to use this connector.' : undefined,
      }
    }
    if (entry.launcher === 'uvx') {
      return {
        blocked: !tools.uvx && !tools.uv,
        reason:
          !tools.uvx && !tools.uv
            ? 'Install uv (or uvx) to use this connector.'
            : undefined,
      }
    }
    return { blocked: false }
  }

  const blockedCount = filteredCatalog.filter((entry) => isBlockedByLauncher(entry).blocked).length

  return (
    <PageScaffold
      active="sources"
      crumbs={['Settings', 'Connections', 'Sources']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="CONNECTIONS · SOURCES"
        title="Where your library comes from."
        desc="Connect a service once. The agent picks it up automatically the next time you chat — ask it 'search my Zotero for HNSW recall papers' and it'll use the connected library."
      />

      {blockedCount > 0 && (
        <div
          role="alert"
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid var(--color-warn)',
            background: 'color-mix(in oklch, var(--color-warn) 8%, transparent)',
            color: 'var(--color-ink-2)',
            fontSize: 13,
            marginBottom: 16,
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 500, color: 'var(--color-ink)', marginBottom: 4 }}>
            Install launchers to enable source connectors
          </div>
          Python-based connectors use <code className="font-mono">uv</code>/<code className="font-mono">uvx</code>,
          JavaScript connectors use <code className="font-mono">npx</code>. Add the
          missing launcher and refresh this page:
          <pre
            className="font-mono"
            style={{
              fontSize: 12,
              background: 'var(--color-paper-2)',
              padding: '8px 10px',
              borderRadius: 6,
              marginTop: 8,
              overflow: 'auto',
            }}
          >
            curl -LsSf https://astral.sh/uv/install.sh | sh
            <br />
            # install Node.js for npx-based connectors
          </pre>
        </div>
      )}

      {!isAdmin && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            fontSize: 12,
            color: 'var(--color-muted)',
            lineHeight: 1.45,
          }}
        >
          Read-only mode: only admins can connect, configure, or disconnect sources.
        </div>
      )}

      <ul
        role="list"
        aria-label="Connector integrations"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
          gap: 14,
        }}
      >
        {filteredCatalog.length === 0 ? (
          <li
            key="sources-empty"
            style={{
              gridColumn: '1 / -1',
              border: '1px dashed var(--color-rule)',
              borderRadius: 12,
              padding: 16,
              fontSize: 13,
              color: 'var(--color-ink-2)',
              background: 'var(--color-paper-2)',
            }}
          >
            No source connectors are available from the catalog right now.
          </li>
        ) : (
          filteredCatalog.map((entry) => {
            const blocker = isBlockedByLauncher(entry)
            const inst = findInstalled(entry.id)
            const connected = !!inst
            const status =
              !entry.available
                ? 'Unavailable'
                : connected
                  ? `Connected${inst?.enabled === false ? ' (disabled)' : ''}`
                  : 'Not connected'

            return (
              <li
                key={entry.id}
                style={{
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 14,
                  padding: 18,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icons.folder size={18} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.name}
                    </div>
                    <div
                      className="font-mono"
                      style={{ fontSize: 11, color: 'var(--color-muted)' }}
                    >
                      {status}
                    </div>
                  </div>
                  {!entry.available ? (
                    <span className="tag" style={{ fontSize: 10 }}>
                      soon
                    </span>
                  ) : connected ? (
                    <span className="tag teal" style={{ fontSize: 10 }}>
                      ✓ connected
                    </span>
                  ) : null}
                </div>
                <p style={{ fontSize: 13, color: 'var(--color-ink-2)', margin: 0, lineHeight: 1.5 }}>
                  {entry.description}
                </p>
                {entry.available && entry.source_fields.length > 0 ? null : (
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--color-muted)',
                      margin: 0,
                      lineHeight: 1.5,
                      fontStyle: 'italic',
                    }}
                  >
                    {entry.source_fields.length === 0
                      ? 'No credentials required for this source.'
                      : 'Source configuration is defined on install.'}
                  </p>
                )}
                {blocker.blocked && (
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--color-warn)',
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {blocker.reason}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
                  {isAdmin &&
                    (entry.available ? (
                      connected && inst ? (
                        <>
                          <button
                            type="button"
                            className="ns-btn ghost tiny"
                            onClick={() => setEditing({ entry, installedId: inst.id })}
                          >
                            Configure
                          </button>
                          <button
                            type="button"
                            className="ns-btn ghost tiny"
                            onClick={() => void onDisconnect(inst)}
                            disabled={busy === inst.id}
                            aria-busy={busy === inst.id || undefined}
                          >
                            Disconnect
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ns-btn primary tiny"
                          onClick={() => setEditing({ entry, installedId: null })}
                          disabled={!!blocker.blocked}
                          title={blocker.blocked ? blocker.reason : 'Connect this source'}
                        >
                          Connect
                        </button>
                      )
                    ) : (
                      <button type="button" className="ns-btn ghost tiny" disabled>
                        Unavailable
                      </button>
                    ))}
                </div>
              </li>
            )
          })
        )}
      </ul>

      {editing && (
        <ConnectorModal
          entry={editing.entry}
          existing={
            editing.installedId
              ? installed?.find((s) => s.id === editing.installedId) ?? null
              : null
          }
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setReloadTick((t) => t + 1)
          }}
        />
      )}
    </PageScaffold>
  )
}

function ConnectorModal({
  entry,
  existing,
  onClose,
  onSaved,
}: {
  entry: CatalogEntry
  existing: InstalledServer | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}
    for (const f of entry.source_fields) {
      if (f.secret) {
        seed[f.path] = ''
        continue
      }
      const cur = getByPath(existing?.config, f.path)
      seed[f.path] = typeof cur === 'string' ? cur : ''
    }
    return seed
  })
  const [saving, setSaving] = useState(false)
  const hasSourceFields = entry.source_fields.length > 0

  const onSubmit = async () => {
    setSaving(true)
    try {
      // 1. Make sure the server is installed. If not, install via the
      // catalog endpoint (this gives us a server row with default config).
      let serverId = existing?.id ?? null
      if (!serverId) {
        const installed = await api<{ id: string }>(
          `/mcp/catalog/${entry.id}/install`,
          { method: 'POST', auth: true, body: JSON.stringify({}) },
        )
        serverId = installed.id
      }
      // 2. PATCH the config with the user-provided values. Start from
      // the existing config (or an empty object) and overlay the fields.
      if (hasSourceFields) {
        const baseConfig: Record<string, unknown> = existing?.config
          ? JSON.parse(JSON.stringify(existing.config))
          : {}
        let hasChanges = false
        for (const f of entry.source_fields) {
          const v = (values[f.path] ?? '').trim()
          if (!v) {
            continue
          }
          setByPath(baseConfig, f.path, v)
          hasChanges = true
        }
        if (hasChanges) {
          await api(`/mcp/servers/${serverId}`, {
            method: 'PATCH',
            auth: true,
            body: JSON.stringify({ config: baseConfig }),
          })
        }
      }
      toast.success(
        existing ? `Updated ${entry.name}.` : `Connected ${entry.name}.`,
      )
      onSaved()
    } catch (err) {
      toast.error(
        errorMessage(err, `Couldn't ${existing ? 'update' : 'connect'} ${entry.name}.`),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={existing ? `Configure ${entry.name}` : `Connect ${entry.name}`}
      description={entry.description}
      onClose={onClose}
      width={520}
      dismissOnOverlayClick={false}
    >
      {!hasSourceFields ? (
        <p style={{ fontSize: 13, color: 'var(--color-ink-2)', lineHeight: 1.55 }}>
          No credentials required — click Connect to install the server.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {entry.source_fields.map((f) => (
            <label key={f.path} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--color-ink)',
                }}
              >
                {f.label}
                {f.secret && (
                  <span
                    className="font-mono"
                    style={{
                      fontSize: 10,
                      color: 'var(--color-muted)',
                      marginLeft: 8,
                    }}
                  >
                    encrypted at rest
                  </span>
                )}
              </span>
              <input
                type={f.secret ? 'password' : 'text'}
                  value={values[f.path] ?? ''}
                  onChange={(e) =>
                    setValues((cur) => ({ ...cur, [f.path]: e.target.value }))
                  }
                  placeholder={
                    f.placeholder ??
                  (f.secret && existing ? 'Leave blank to keep current value' : '')
                }
                autoComplete="off"
                style={{
                  padding: '8px 10px',
                  background: 'var(--color-paper-2)',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: f.secret ? 'var(--font-mono)' : 'inherit',
                  color: 'var(--color-ink)',
                  outline: 'none',
                }}
              />
              {f.help_url && (
                <a
                  href={f.help_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--color-indigo)',
                    textDecoration: 'none',
                  }}
                >
                  Where do I get this? ↗
                </a>
              )}
            </label>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button
          type="button"
          className="ns-btn ghost tiny"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ns-btn primary tiny"
          onClick={() => void onSubmit()}
          disabled={saving}
          aria-busy={saving || undefined}
        >
          {saving ? 'Saving…' : existing ? 'Save' : 'Connect'}
        </button>
      </div>
    </Modal>
  )
}

/* -------------------- Models & keys -------------------- */

interface ProviderKeyStatus {
  provider_id: string
  display_name: string
  env_var: string
  set: boolean
  last4: string | null
  updated_at: string | null
}

interface CustomEmbeddingConfig {
  enabled: boolean
  base_url: string
  model: string
  dimension: number
  api_key_set: boolean
  updated_at: string | null
}

const KEY_PLACEHOLDERS: Record<string, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  google_genai: 'AIza…',
  deepseek: 'sk-…',
}

export function ModelsPage() {
  const { me } = useMe()
  const toast = useToast()
  const [confirm, confirmDialog] = useConfirm()
  const [keys, setKeys] = useState<ProviderKeyStatus[] | null>(null)
  const [catalog, setCatalog] = useState<ProvidersAvailable | null>(() => peekProviders())
  const [embeddingConfig, setEmbeddingConfig] = useState<CustomEmbeddingConfig | null>(null)
  const [embeddingDraft, setEmbeddingDraft] = useState({
    enabled: false,
    base_url: '',
    model: '',
    api_key: '',
    dimension: 1536,
  })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const r = await api<{ keys: ProviderKeyStatus[] }>('/me/provider-keys', {
        auth: true,
      })
      setKeys(r.keys)
      const emb = await api<CustomEmbeddingConfig>('/me/embedding-config', {
        auth: true,
      })
      setEmbeddingConfig(emb)
      setEmbeddingDraft((cur) => ({
        ...cur,
        enabled: emb.enabled,
        base_url: emb.base_url,
        model: emb.model,
        dimension: emb.dimension,
        api_key: '',
      }))
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't load provider keys."))
    }
  }
  useEffect(() => {
    void refresh()
    void getProviders().then(setCatalog).catch(() => {
      /* status card degrades gracefully */
    })
    return subscribeProviders(setCatalog)
  }, [])

  const save = async (providerId: string) => {
    const value = (drafts[providerId] ?? '').trim()
    if (!value) return
    setSaving(providerId)
    try {
      await api(`/me/provider-keys/${providerId}`, {
        method: 'PUT',
        auth: true,
        body: JSON.stringify({ api_key: value }),
      })
      setDrafts((d) => ({ ...d, [providerId]: '' }))
      toast.success('Key saved.')
      await refresh()
      await refreshProviders().then(setCatalog).catch(() => null)
      // Nudge the models catalog so the workspace picker re-enables
      // the provider's models without a page refresh.
      window.dispatchEvent(new Event('notesci-prefs-changed'))
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't save that key."))
    } finally {
      setSaving(null)
    }
  }

  const remove = async (k: ProviderKeyStatus) => {
    const ok = await confirm({
      title: `Remove ${k.display_name} key?`,
      description:
        'The provider will stop being available unless an env-var fallback is configured on the backend.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!ok) return
    try {
      await api(`/me/provider-keys/${k.provider_id}`, {
        method: 'DELETE',
        auth: true,
      })
      toast.success('Key removed.')
      await refresh()
      await refreshProviders().then(setCatalog).catch(() => null)
      window.dispatchEvent(new Event('notesci-prefs-changed'))
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't remove that key."))
    }
  }

  const saveEmbeddingConfig = async () => {
    setSaving('embedding')
    try {
      const saved = await api<CustomEmbeddingConfig>('/me/embedding-config', {
        method: 'PUT',
        auth: true,
        body: JSON.stringify(embeddingDraft),
      })
      setEmbeddingConfig(saved)
      setEmbeddingDraft((cur) => ({ ...cur, api_key: '' }))
      await refreshProviders().then(setCatalog).catch(() => null)
      toast.success('Embedding endpoint saved.')
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't save embedding endpoint."))
    } finally {
      setSaving(null)
    }
  }

  return (
    <PageScaffold
      active="models"
      crumbs={['Settings', 'Connections', 'Models & keys']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="CONNECTIONS"
        title="Models & keys"
        desc="Paste a provider's API key to unlock its models. Keys are stored encrypted on this machine and never leave it."
      />
      <SectionCard
        title="OpenAI setup"
        desc="ChatGPT subscriptions and OpenAI API access are separate. A ChatGPT Plus or Pro plan cannot be used to authenticate notesci."
      >
        <LRow
          label="WHAT TO USE"
          value="OpenAI API key"
          help="Create an API key on the OpenAI Platform. notesci sends API requests with that key; it does not log in to chatgpt.com or reuse ChatGPT web sessions."
          action={
            <a
              className="ns-btn ghost tiny"
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer"
            >
              API keys ↗
            </a>
          }
        />
        <LRow
          label="BILLING"
          value="Platform billing"
          help="OpenAI manages ChatGPT billing and API billing separately. If you use OpenAI models in notesci, usage is billed through the API platform, not your ChatGPT Plus subscription."
          action={
            <a
              className="ns-btn ghost tiny"
              href="https://platform.openai.com/settings/organization/billing/overview"
              target="_blank"
              rel="noreferrer"
            >
              API billing ↗
            </a>
          }
        />
        <LRow
          label="NOT SUPPORTED"
          value="ChatGPT web login"
          help="notesci intentionally does not scrape ChatGPT cookies, browser sessions, or unofficial tokens. That avoids brittle behavior and avoids bypassing OpenAI's API access and billing boundary."
        />
      </SectionCard>
      <SectionCard
        title="Providers"
        desc="Each provider is independent. You only need a key for the providers whose models you want to use."
      >
        {keys === null ? (
          <div
            style={{ padding: '14px 18px', fontSize: 12.5, color: 'var(--color-muted)' }}
          >
            Loading…
          </div>
        ) : (
          keys.map((k) => (
            <LRow
              key={k.provider_id}
              label={k.display_name.toUpperCase()}
              value={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {k.set ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12.5,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: 'var(--color-teal, #0a7e7e)',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: 'var(--color-ink-2)' }}>
                        Set · ends in{' '}
                        <code
                          className="font-mono"
                          style={{
                            padding: '2px 6px',
                            background: 'var(--color-paper-2)',
                            borderRadius: 4,
                          }}
                        >
                          …{k.last4}
                        </code>
                      </span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--color-muted)' }}>
                      Not set
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="password"
                      autoComplete="off"
                      className="ns-input"
                      placeholder={
                        k.set
                          ? 'Paste new key to replace…'
                          : KEY_PLACEHOLDERS[k.provider_id] ?? 'API key'
                      }
                      value={drafts[k.provider_id] ?? ''}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [k.provider_id]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return
                        if (e.key === 'Enter' && (drafts[k.provider_id] ?? '').trim()) {
                          e.preventDefault()
                          void save(k.provider_id)
                        }
                      }}
                      style={{ flex: 1, fontFamily: 'inherit' }}
                    />
                    <button
                      type="button"
                      className="ns-btn"
                      onClick={() => void save(k.provider_id)}
                      disabled={
                        saving === k.provider_id || !(drafts[k.provider_id] ?? '').trim()
                      }
                    >
                      {saving === k.provider_id ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              }
              help={`Backend env var: ${k.env_var}. ${
                k.set
                  ? 'Stored on this machine. Use Remove to clear.'
                  : 'Paste a key and click Save to enable this provider.'
              }`}
              action={
                k.set ? (
                  <button
                    type="button"
                    className="ns-btn ghost tiny ns-danger-btn"
                    onClick={() => void remove(k)}
                  >
                    Remove
                  </button>
                ) : undefined
              }
            />
          ))
        )}
      </SectionCard>
      <SectionCard
        title="Embedding / source indexing"
        desc="Uploads need a real embedding model to make sources searchable. Chat and digest reasoning can still use DeepSeek; indexing can use OpenAI, Gemini, or a custom OpenAI-compatible embedding endpoint."
      >
        <LRow
          label="STATUS"
          value={
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                color: catalog?.embedding?.available
                  ? 'var(--color-ink-2)'
                  : 'var(--color-error)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: catalog?.embedding?.available
                    ? 'var(--color-teal, #0a7e7e)'
                    : 'var(--color-error)',
                }}
              />
              {catalog?.embedding?.available
                ? `Ready · ${catalog.embedding.label ?? catalog.embedding.model}`
                : 'Missing embedding provider'}
            </span>
          }
          help={
            catalog?.embedding?.available
              ? 'PDF and URL uploads can be indexed. DeepSeek can still be used for chat and digest reasoning if selected.'
              : 'Add an OpenAI or Google key above, or configure a custom embedding endpoint below.'
          }
        />
        <LRow
          label="SUPPORTED"
          value="OpenAI · text-embedding-3-small, Google · gemini-embedding-001, custom OpenAI-compatible"
          help="All indexing embeddings are stored as 1536-dimensional vectors to match the current database schema."
        />
        <LRow
          label="DEEPSEEK"
          value="Chat/digest only"
          help="DeepSeek's official API is suitable for reasoning stages, but it does not provide the embedding endpoint notesci needs for retrieval indexing."
        />
        <LRow
          label="CUSTOM"
          value={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={embeddingDraft.enabled}
                  onChange={(e) =>
                    setEmbeddingDraft((cur) => ({ ...cur, enabled: e.target.checked }))
                  }
                />
                Use custom OpenAI-compatible endpoint for indexing
              </label>
              <input
                className="ns-input"
                type="url"
                placeholder="https://provider.example.com/v1"
                value={embeddingDraft.base_url}
                onChange={(e) =>
                  setEmbeddingDraft((cur) => ({ ...cur, base_url: e.target.value }))
                }
              />
              <input
                className="ns-input"
                placeholder="embedding model id"
                value={embeddingDraft.model}
                onChange={(e) =>
                  setEmbeddingDraft((cur) => ({ ...cur, model: e.target.value }))
                }
              />
              <input
                className="ns-input"
                type="password"
                autoComplete="off"
                placeholder={
                  embeddingConfig?.api_key_set
                    ? 'Paste new API key to replace…'
                    : 'Embedding endpoint API key'
                }
                value={embeddingDraft.api_key}
                onChange={(e) =>
                  setEmbeddingDraft((cur) => ({ ...cur, api_key: e.target.value }))
                }
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  className="ns-input"
                  type="number"
                  value={embeddingDraft.dimension}
                  readOnly
                  style={{ width: 110 }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                  dimension is fixed until a vector-schema migration exists
                </span>
              </div>
            </div>
          }
          help={
            embeddingConfig?.enabled
              ? `Enabled${embeddingConfig.api_key_set ? ' · API key saved' : ''}`
              : 'Optional. Use this for providers that expose an OpenAI-compatible /embeddings endpoint returning 1536-dimensional vectors.'
          }
          action={
            <button
              type="button"
              className="ns-btn tiny"
              disabled={saving === 'embedding'}
              aria-busy={saving === 'embedding' || undefined}
              onClick={() => void saveEmbeddingConfig()}
            >
              {saving === 'embedding' ? 'Saving…' : 'Save'}
            </button>
          }
        />
      </SectionCard>
      {confirmDialog}
    </PageScaffold>
  )
}

/* -------------------- Citations & export -------------------- */

interface SessionLite {
  id: string
  project_id: string | null
  title: string | null
  updated_at: string
  kind?: string
}

export function CitationsPage() {
  const { me } = useMe()
  const [sessions, setSessions] = useState<SessionLite[]>([])
  const [loading, setLoading] = useState(true)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const toast = useToast()
  useEffect(() => {
    setLoading(true)
    void (async () => {
      try {
        const projects = await api<{ id: string }[]>('/projects', { auth: true })
        const all: SessionLite[] = []
        for (const p of projects) {
          try {
            const ss = await api<SessionLite[]>(
              `/projects/${p.id}/sessions`,
              { auth: true },
            )
            all.push(...ss)
          } catch {
            /* skip */
          }
        }
        try {
          const general = await api<SessionLite[]>('/general/sessions', {
            auth: true,
          })
          all.push(...general)
        } catch {
          /* skip */
        }
        all.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        setSessions(all)
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [refreshTick])

  const onExport = async (sessionId: string, sessionTitle: string | null) => {
    setDownloadingId(sessionId)
    try {
      const blob = await apiBlob(`/sessions/${sessionId}/export/citations.bib`, {
        auth: true,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const safeName = (sessionTitle || 'session')
        .replace(/[^a-z0-9-_ ]/gi, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase()
      a.download = `notesci-${safeName || 'session'}-citations.bib`
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Citation export downloaded.')
    } catch {
      toast.error("Couldn't download citations.")
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <PageScaffold
      active="citations"
      crumbs={['Settings', 'Research', 'Citations & export']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="RESEARCH"
        title="Citations & export"
        desc="Every chat session keeps a citation graph. Export as BibTeX today; APA / Chicago / Vancouver / MLA land later."
        action={
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={loading}
            aria-busy={loading || undefined}
            aria-label="Refresh sessions"
            title="Refresh"
          >
            <Icons.reset size={12} />
          </button>
        }
      />
      <SectionCard
        title="Default formats"
        desc="When the agent cites a source it picks this style. Per-project overrides land later."
      >
        <LRow label="EXPORT FORMAT" value="BibTeX (.bib) · @misc entries with arXiv-aware fields" />
      </SectionCard>
      <SectionCard
        title="Recent sessions"
        desc="Click a session to download its BibTeX export."
      >
        {sessions.length === 0 ? (
          <div role="status" style={{ padding: 32, color: 'var(--color-muted)', textAlign: 'center', fontSize: 13.5 }}>
            No chat sessions yet. Start one in the workspace and citations will appear here.
          </div>
        ) : (
          <ul
            aria-label="Recent sessions"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
          {sessions.slice(0, 8).map((s) => (
            <li key={s.id}>
            <LRow
              label="SESSION"
              value={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 13.5 }}>{s.title ?? 'Untitled session'}</div>
                  <div
                    className="font-mono"
                    style={{ fontSize: 11, color: 'var(--color-muted)' }}
                    title={new Date(s.updated_at).toLocaleString()}
                  >
                    {s.id.slice(0, 8)} · updated {relativeTime(s.updated_at)}
                  </div>
                </div>
              }
                  action={
                <button
                  type="button"
                  className="ns-btn ghost tiny"
                  onClick={() => void onExport(s.id, s.title)}
                  disabled={downloadingId === s.id}
                  aria-label={`Download BibTeX citations for ${s.title ?? 'this session'}`}
                >
                  <Icons.doc size={12} /> {downloadingId === s.id ? 'Downloading…' : '.bib'}
                </button>
              }
            />
            </li>
          ))}
          </ul>
        )}
      </SectionCard>
    </PageScaffold>
  )
}

/* -------------------- Library -------------------- */

interface ProjectWithMeta {
  id: string
  name: string
  updated_at: string
}

export function LibraryPage() {
  const { me } = useMe()
  const [projects, setProjects] = useState<ProjectWithMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    setLoading(true)
    void (async () => {
      try {
        const ps = await api<ProjectWithMeta[]>('/projects', { auth: true })
        setProjects(ps)
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [refreshTick])
  return (
    <PageScaffold
      active="library"
      crumbs={['Library']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="LIBRARY"
        title="All projects"
        desc="Cross-project search across projects, sessions, and materials. Pick a project to jump into the workspace."
        action={
          <button
            type="button"
            className="ns-btn ghost tiny"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={loading}
            aria-busy={loading || undefined}
            aria-label="Refresh project list"
            title="Refresh"
          >
            <Icons.reset size={12} />
          </button>
        }
      />
      <SectionCard title="Projects">
        {projects.length === 0 ? (
          <div
            role="status"
            style={{
              padding: '32px 24px',
              color: 'var(--color-muted)',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              fontSize: 13.5,
              lineHeight: 1.55,
            }}
          >
            <div>
              No projects yet. Open the workspace to create your first one.
            </div>
            <Link to="/" className="ns-btn ghost tiny">
              Open workspace
            </Link>
          </div>
        ) : (
          <ul
            aria-label="Projects"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
          {projects.map((p) => (
            <li key={p.id}>
            <LRow
              label="PROJECT"
              value={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</div>
                  <div
                    className="font-mono"
                    style={{ fontSize: 11, color: 'var(--color-muted)' }}
                    title={new Date(p.updated_at).toLocaleString()}
                  >
                    Updated {relativeTime(p.updated_at)}
                  </div>
                </div>
              }
              action={
                <Link
                  to={`/p/${p.id}`}
                  className="ns-btn ghost tiny"
                  aria-label={`Open project ${p.name}`}
                >
                  Open
                </Link>
              }
            />
            </li>
          ))}
          </ul>
        )}
      </SectionCard>
    </PageScaffold>
  )
}

/* -------------------- Help: shortcuts + changelog -------------------- */

export function ShortcutsPage() {
  const { me } = useMe()
  const groups: { name: string; rows: [string, string][] }[] = [
    {
      name: 'Workspace',
      rows: [
        ['⌘K', 'Open command palette'],
        ['⌘↩', 'Send message'],
        ['⌘\\', 'Toggle side panel'],
        ['⌘1 / ⌘2 / ⌘3', 'Switch graph mode'],
      ],
    },
    {
      name: 'Editor',
      rows: [
        ['/', 'Slash menu'],
        ['@', 'Mention a source'],
        ['⌘B / ⌘I', 'Bold / italic'],
      ],
    },
  ]
  return (
    <PageScaffold
      active="shortcuts"
      crumbs={['Settings', 'Help', 'Keyboard shortcuts']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="HELP"
        title="Keyboard shortcuts"
        desc="Notesci is keyboard-first. Most things have a chord. Use Ctrl in place of ⌘ on Windows / Linux."
      />
      {groups.map((g) => (
        <SectionCard key={g.name} title={g.name}>
          {g.rows.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '160px 1fr',
                padding: '12px 18px',
                borderBottom: '1px solid var(--color-rule)',
                gap: 18,
                alignItems: 'center',
              }}
            >
              <kbd
                className="font-mono"
                style={{
                  fontSize: 12,
                  background: 'var(--color-paper-2)',
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--color-rule)',
                  width: 'fit-content',
                }}
              >
                {k}
              </kbd>
              <span style={{ fontSize: 13.5 }}>{v}</span>
            </div>
          ))}
        </SectionCard>
      ))}
    </PageScaffold>
  )
}

export function ChangelogPage() {
  const { me } = useMe()
  return (
    <PageScaffold
      active="changelog"
      crumbs={['Settings', 'Help', "What's new"]}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="HELP"
        title="What's new"
        desc="Release notes will appear here as new versions of notesci ship."
      />
      <SectionCard title="No updates yet">
        <div
          style={{
            padding: 24,
            color: 'var(--color-muted)',
            fontSize: 13.5,
            lineHeight: 1.6,
          }}
        >
          This is where notesci’s changelog will live. As releases ship,
          each version and its highlights will show up here, newest first.
        </div>
      </SectionCard>
    </PageScaffold>
  )
}
