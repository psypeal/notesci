import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader, PageScaffold, SectionCard } from '../../components/dashboard/PageScaffold'
import { Icons } from '../../components/icons'
import { McpIcon } from '../../components/mcpIcons'
import { api, errorMessage, type ApiError } from '../../lib/api'
import { useMe, userCard } from './useMe'
import { ConfirmModal } from '../../components/Modal'
import { useToast } from '../../components/Toast'

interface McpServer {
  id: string
  slug: string
  name: string
  transport: string
  config: Record<string, unknown>
  grants: { tools?: string[]; allowAll?: boolean; deniedTools?: string[] }
  enabled: boolean
  created_at: string
}

interface McpServerStatus {
  status: 'ready' | 'failed' | 'missing_config'
  tool_count: number
  error: string | null
  checked_at: string
}

/**
 * Installed MCPs page — Connections > Installed MCPs.
 * Real CRUD against /mcp/servers.
 */
export function McpInstalledPage() {
  const { me } = useMe()
  const [servers, setServers] = useState<McpServer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<McpServer | null>(null)
  const [editingConfig, setEditingConfig] = useState<McpServer | null>(null)
  const [configDraft, setConfigDraft] = useState('')
  const [obsidianDraft, setObsidianDraft] = useState({
    apiKey: '',
    host: '127.0.0.1',
    port: '27124',
  })
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({})
  const [loading, setLoading] = useState(true)
  const isAdmin = me?.role === 'admin'
  const toast = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const s = await api<McpServer[]>('/mcp/servers', { auth: true })
      setServers(s)
      setError(null)
    } catch (err) {
      const e = err as ApiError
      setError(errorMessage(err, `Couldn't load installed servers (${e.status}).`))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const onToggle = async (s: McpServer) => {
    if (!isAdmin) return
    setBusy(s.id)
    try {
      await api(`/mcp/servers/${s.id}`, {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ enabled: !s.enabled }),
      })
      await load()
      toast.success(s.enabled ? `Disabled ${s.name}.` : `Enabled ${s.name}.`)
    } catch (err) {
      toast.error(
        errorMessage(err, `Couldn't ${s.enabled ? 'disable' : 'enable'} ${s.name}.`),
      )
    } finally {
      setBusy(null)
    }
  }

  const onUninstall = (s: McpServer) => {
    if (!isAdmin) return
    setPendingUninstall(s)
  }

  const confirmUninstall = async () => {
    const s = pendingUninstall
    if (!s) return
    setBusy(s.id)
    try {
      await api(`/mcp/servers/${s.id}`, { method: 'DELETE', auth: true })
      toast.success(`Uninstalled ${s.name}.`)
      await load()
    } catch (err) {
      toast.error(errorMessage(err, `Couldn't uninstall ${s.name}.`))
    } finally {
      setBusy(null)
    }
  }

  const openConfigEditor = (s: McpServer) => {
    if (!isAdmin) return
    setEditingConfig(s)
    setConfigDraft(JSON.stringify(s.config, null, 2))
    if (s.slug === 'obsidian') {
      const env = (s.config.env ?? {}) as Record<string, unknown>
      setObsidianDraft({
        apiKey: env.OBSIDIAN_API_KEY === '***' ? '' : String(env.OBSIDIAN_API_KEY ?? ''),
        host: String(env.OBSIDIAN_HOST ?? '127.0.0.1'),
        port: String(env.OBSIDIAN_PORT ?? '27124'),
      })
    }
  }

  const saveConfig = async () => {
    const s = editingConfig
    if (!s) return
    let parsed: unknown
    if (s.slug === 'obsidian') {
      const existing = s.config
      const existingEnv = (existing.env ?? {}) as Record<string, unknown>
      parsed = {
        ...existing,
        command: 'uvx',
        args: ['mcp-obsidian'],
        env: {
          ...existingEnv,
          OBSIDIAN_API_KEY: obsidianDraft.apiKey.trim() || existingEnv.OBSIDIAN_API_KEY || '',
          OBSIDIAN_HOST: obsidianDraft.host.trim() || '127.0.0.1',
          OBSIDIAN_PORT: obsidianDraft.port.trim() || '27124',
        },
      }
    } else {
      try {
        parsed = JSON.parse(configDraft)
      } catch {
        toast.error('Config must be valid JSON.')
        return
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast.error('Config must be a JSON object.')
      return
    }
    setBusy(s.id)
    try {
      await api(`/mcp/servers/${s.id}`, {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ config: parsed }),
      })
      toast.success(`Updated ${s.name} config.`)
      setEditingConfig(null)
      try {
        const status = await api<McpServerStatus>(`/mcp/servers/${s.id}/status`, {
          method: 'POST',
          auth: true,
          body: JSON.stringify({}),
        })
        setStatuses((cur) => ({ ...cur, [s.id]: status }))
      } catch (statusErr) {
        toast.warn(errorMessage(statusErr, `Config saved, but couldn't check ${s.name}.`))
      }
      await load()
    } catch (err) {
      toast.error(errorMessage(err, `Couldn't update ${s.name}.`))
    } finally {
      setBusy(null)
    }
  }

  const checkStatus = async (s: McpServer) => {
    setBusy(`status:${s.id}`)
    try {
      const status = await api<McpServerStatus>(`/mcp/servers/${s.id}/status`, {
        method: 'POST',
        auth: true,
        body: JSON.stringify({}),
      })
      setStatuses((cur) => ({ ...cur, [s.id]: status }))
      if (status.status === 'ready') {
        toast.success(`${s.name} is ready (${status.tool_count} tools).`)
      } else {
        toast.warn(status.error ?? `${s.name} is not ready.`)
      }
    } catch (err) {
      toast.error(errorMessage(err, `Couldn't check ${s.name}.`))
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageScaffold
      active="mcp-installed"
      crumbs={['Settings', 'Connections', 'Installed MCPs']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="CONNECTIONS"
        title="MCP servers"
        desc={
          isAdmin
            ? "Tools the agent can call during chat. Ask the agent to install an MCP and it'll show up here with its scope grant — the agent can only call tools you've approved."
            : "Tools the agent can call during chat. MCP management is admin-only; ask an admin to install, configure, enable, or uninstall."
        }
        action={
          <div role="toolbar" aria-label="MCP server actions" style={{ display: 'flex', gap: 6 }}>
            <Link to="/settings/marketplace" className="ns-btn ghost tiny">
              Browse marketplace
            </Link>
            <button
              type="button"
              className="ns-btn ghost tiny"
              onClick={() => void load()}
              disabled={loading}
              aria-busy={loading || undefined}
              aria-label="Refresh installed servers"
              title="Refresh"
            >
              <Icons.reset size={12} />
            </button>
          </div>
        }
      />

      {error && (
        <div
          role="alert"
          style={{
            padding: 12,
            borderRadius: 10,
            color: 'var(--color-error)',
            background: 'color-mix(in oklch, var(--color-error) 8%, transparent)',
            marginBottom: 18,
          }}
        >
          {error}
        </div>
      )}

      {servers.length === 0 ? (
        <SectionCard>
          <div
            role="status"
            style={{
              padding: '40px 18px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              textAlign: 'center',
              color: 'var(--color-muted)',
            }}
          >
            <span aria-hidden>
              <Icons.share size={36} />
            </span>
            <div className="font-serif" style={{ fontSize: 22, color: 'var(--color-ink)' }}>
              No MCP servers installed.
            </div>
            <p style={{ fontSize: 13.5, maxWidth: 380, lineHeight: 1.55 }}>
              Ask the agent in chat to add an MCP — e.g. "install the
              Semantic Scholar MCP" or "connect my GitHub MCP." Each
              server it installs lands here with its scope grant.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          {!isAdmin ? (
            <div
              role="status"
              style={{
                marginBottom: 14,
                color: 'var(--color-muted)',
                fontSize: 12,
              }}
            >
              Management actions are read-only for non-admin users. Ask an admin to
              enable, disable, or uninstall MCP servers.
            </div>
          ) : null}

          <ul
            role="list"
            aria-label={`${servers.length} installed MCP server${servers.length === 1 ? '' : 's'}`}
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {servers.map((s) => (
              <li key={s.id}>
                <SectionCard
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                      <McpIcon name={s.slug} size={14} />
                      {s.name}
                      <span className="tag" style={{ fontSize: 10 }}>
                        {s.transport}
                      </span>
                      <span
                        className={`tag ${s.enabled ? 'teal' : 'warn'}`}
                        style={{ fontSize: 10 }}
                      >
                        {s.enabled ? '✓ enabled' : 'disabled'}
                      </span>
                    </span>
                  }
                  desc={`${s.slug} · installed ${new Date(s.created_at).toLocaleDateString()}`}
                  action={
                    <div role="toolbar" aria-label={`${s.name} actions`} style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="ns-btn ghost tiny"
                        disabled={busy === s.id || !isAdmin}
                        aria-busy={busy === s.id || undefined}
                        onClick={() => onToggle(s)}
                        aria-label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                      >
                        {s.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        className="ns-btn ghost tiny"
                        disabled={busy === s.id || !isAdmin}
                        onClick={() => openConfigEditor(s)}
                        aria-label={`Edit ${s.name} config`}
                      >
                        Configure
                      </button>
                      <button
                        type="button"
                        className="ns-btn ghost tiny"
                        disabled={busy === `status:${s.id}`}
                        aria-busy={busy === `status:${s.id}` || undefined}
                        onClick={() => void checkStatus(s)}
                        aria-label={`Check ${s.name} status`}
                      >
                        Check
                      </button>
                      <button
                        type="button"
                        className="ns-btn ghost tiny"
                        disabled={busy === s.id || !isAdmin}
                        aria-busy={busy === s.id || undefined}
                        onClick={() => onUninstall(s)}
                        aria-label={`Uninstall ${s.name}`}
                      >
                        Uninstall
                      </button>
                    </div>
                  }
                >
                  <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {statuses[s.id] && (
                      <div
                        role="status"
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--color-rule)',
                          background:
                            statuses[s.id].status === 'ready'
                              ? 'color-mix(in oklch, var(--color-teal) 9%, transparent)'
                              : 'color-mix(in oklch, var(--color-warn) 12%, transparent)',
                          fontSize: 12,
                          color: 'var(--color-ink-2)',
                          lineHeight: 1.45,
                        }}
                      >
                        <strong style={{ color: 'var(--color-ink)' }}>
                          {statuses[s.id].status === 'ready'
                            ? `Ready · ${statuses[s.id].tool_count} tools`
                            : statuses[s.id].status === 'missing_config'
                              ? 'Missing configuration'
                              : 'Failed to load'}
                        </strong>
                        {statuses[s.id].error ? ` — ${statuses[s.id].error}` : ''}
                      </div>
                    )}
                    <div>
                      <div className="lrow-label">SCOPE GRANT</div>
                      {s.grants.allowAll ? (
                        <span className="tag indigo" style={{ fontSize: 11 }}>
                          All tools allowed
                        </span>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {(s.grants.tools ?? []).map((t) => (
                            <span key={t} className="tag" style={{ fontSize: 11 }}>
                              {t}
                            </span>
                          ))}
                          {(s.grants.tools?.length ?? 0) === 0 && (
                            <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>
                              No tools granted yet.
                            </span>
                          )}
                        </div>
                      )}
                      {(s.grants.deniedTools?.length ?? 0) > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <div className="lrow-label" style={{ marginBottom: 4 }}>
                            DENIED
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {s.grants.deniedTools!.map((t) => (
                              <span key={t} className="tag danger" style={{ fontSize: 11 }}>
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="lrow-label">CONFIG</div>
                      <pre
                        className="font-mono"
                        style={{
                          fontSize: 11,
                          background: 'var(--color-paper-2)',
                          padding: '8px 10px',
                          borderRadius: 8,
                          overflow: 'auto',
                          margin: 0,
                        }}
                      >
                        {JSON.stringify(s.config, null, 2)}
                      </pre>
                    </div>

                    <Link
                      to={`/settings/mcp/${s.id}/calls`}
                      style={{ fontSize: 12, color: 'var(--color-indigo)' }}
                    >
                      View call log →
                    </Link>
                  </div>
                </SectionCard>
              </li>
            ))}
          </ul>
        </>
      )}

      {pendingUninstall && (
        <ConfirmModal
          title={`Uninstall ${pendingUninstall.name}?`}
          description="The server will be removed and any open sessions using it will lose access until you reinstall."
          confirmLabel="Uninstall"
          destructive
          onConfirm={() => void confirmUninstall()}
          onClose={() => setPendingUninstall(null)}
        />
      )}
      {editingConfig && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mcp-config-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(14,17,22,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
            padding: 24,
          }}
          onClick={() => setEditingConfig(null)}
        >
          <div
            className="section-card"
            style={{
              width: 'min(760px, 100%)',
              maxHeight: '85vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              background: '#fff',
              boxShadow: '0 24px 80px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-card-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 id="mcp-config-title" className="section-card-title">
                  Configure {editingConfig.name}
                </h2>
                <p className="section-card-desc">
                  Edit the runtime JSON passed to this MCP server. For Obsidian, paste the Local REST API key into env.OBSIDIAN_API_KEY.
                </p>
              </div>
            </div>
            <div style={{ padding: 18, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {editingConfig.slug === 'obsidian' ? (
                <div style={{ display: 'grid', gap: 12 }}>
                  <label style={{ display: 'grid', gap: 5 }}>
                    <span className="lrow-label">Local REST API key</span>
                    <input
                      className="ns-input"
                      type="password"
                      value={obsidianDraft.apiKey}
                      onChange={(e) =>
                        setObsidianDraft((cur) => ({
                          ...cur,
                          apiKey: e.target.value,
                        }))
                      }
                      placeholder="Leave blank to keep the saved key"
                    />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
                    <label style={{ display: 'grid', gap: 5 }}>
                      <span className="lrow-label">Host</span>
                      <input
                        className="ns-input"
                        value={obsidianDraft.host}
                        onChange={(e) =>
                          setObsidianDraft((cur) => ({
                            ...cur,
                            host: e.target.value,
                          }))
                        }
                        placeholder="127.0.0.1"
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 5 }}>
                      <span className="lrow-label">Port</span>
                      <input
                        className="ns-input"
                        value={obsidianDraft.port}
                        onChange={(e) =>
                          setObsidianDraft((cur) => ({
                            ...cur,
                            port: e.target.value,
                          }))
                        }
                        placeholder="27124"
                      />
                    </label>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--color-muted)', lineHeight: 1.5 }}>
                    Uses <code>uvx mcp-obsidian</code>. Enable Obsidian's Local REST API plugin,
                    copy its API key here, then click Save config and Check.
                  </div>
                </div>
              ) : (
                <textarea
                  className="ns-input mono"
                  value={configDraft}
                  onChange={(e) => setConfigDraft(e.target.value)}
                  spellCheck={false}
                  style={{
                    minHeight: 320,
                    resize: 'vertical',
                    fontSize: 11.5,
                    lineHeight: 1.55,
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                />
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="ns-btn ghost"
                  onClick={() => setEditingConfig(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ns-btn"
                  disabled={busy === editingConfig.id}
                  aria-busy={busy === editingConfig.id || undefined}
                  onClick={() => void saveConfig()}
                >
                  Save config
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageScaffold>
  )
}
