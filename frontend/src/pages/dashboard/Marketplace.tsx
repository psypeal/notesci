import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader, PageScaffold, SectionCard } from '../../components/dashboard/PageScaffold'
import { Icons } from '../../components/icons'
import { McpIcon } from '../../components/mcpIcons'
import { api, errorMessage } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { useMe, userCard } from './useMe'

type ResourceType = 'mcp' | 'skill' | 'plugin'

interface MarketplaceSummary {
  id: string
  type: ResourceType
  name: string
  description: string
  publisher: string
  category: string
  version: string | null
  verified: boolean
  available: boolean
  installed: boolean
  enabled: boolean
  rating: number | null
  install_count: string | null
  badges: string[]
}

interface MarketplaceDetail extends MarketplaceSummary {
  details: Record<string, unknown>
  permissions: string[]
  install_notes: string | null
}

const TYPE_LABEL: Record<ResourceType, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  plugin: 'Plugin',
}

const TYPES: Array<ResourceType | 'all'> = ['all', 'mcp', 'skill', 'plugin']

export function MarketplacePage() {
  const { me } = useMe()
  const toast = useToast()
  const [resources, setResources] = useState<MarketplaceSummary[] | null>(null)
  const [details, setDetails] = useState<Record<string, MarketplaceDetail>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<ResourceType | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const isAdmin = me?.role === 'admin'

  useEffect(() => {
    void (async () => {
      try {
        const rows = await api<MarketplaceSummary[]>('/marketplace/resources', { auth: true })
        setResources(rows)
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't load marketplace."))
        setResources([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (resources ?? [])
      .filter((r) => typeFilter === 'all' || r.type === typeFilter)
      .filter((r) => {
        if (!q) return true
        return [
          r.name,
          r.description,
          r.publisher,
          r.category,
          TYPE_LABEL[r.type],
          ...r.badges,
        ]
          .join(' ')
          .toLowerCase()
          .includes(q)
      })
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1
        if (a.verified !== b.verified) return a.verified ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [query, resources, typeFilter])

  const loadDetail = async (r: MarketplaceSummary) => {
    const key = resourceKey(r)
    setOpen((cur) => (cur === key ? null : key))
    if (details[key]) return
    setBusy(`detail:${key}`)
    try {
      const detail = await api<MarketplaceDetail>(
        `/marketplace/resources/${r.type}/${r.id}`,
        { auth: true },
      )
      setDetails((prev) => ({ ...prev, [key]: detail }))
    } catch (err) {
      toast.error(errorMessage(err, `Couldn't load ${r.name}.`))
    } finally {
      setBusy(null)
    }
  }

  const install = async (r: MarketplaceSummary) => {
    const key = resourceKey(r)
    let existingDetail = details[key]
    if (!existingDetail) {
      try {
        existingDetail = await api<MarketplaceDetail>(
          `/marketplace/resources/${r.type}/${r.id}`,
          { auth: true },
        )
        setDetails((prev) => ({ ...prev, [key]: existingDetail! }))
      } catch (err) {
        toast.error(errorMessage(err, `Couldn't load ${r.name}.`))
        return
      }
    }
    if (existingDetail.install_notes) {
      const ok = window.confirm(existingDetail.install_notes)
      if (!ok) return
    }
    setBusy(`install:${key}`)
    try {
      const detail = await api<MarketplaceDetail>(
        `/marketplace/resources/${r.type}/${r.id}/install`,
        { method: 'POST', auth: true },
      )
      setDetails((prev) => ({ ...prev, [key]: detail }))
      setResources((prev) =>
        (prev ?? []).map((item) =>
          resourceKey(item) === key ? summaryFromDetail(detail) : item,
        ),
      )
      toast.success(`Installed ${r.name}.`)
    } catch (err) {
      toast.error(errorMessage(err, `Couldn't install ${r.name}.`))
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageScaffold
      active="marketplace"
      crumbs={['Settings', 'Marketplace']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="MARKETPLACE"
        title="Install local capabilities."
        desc="Browse curated MCP servers, skills, and plugins. Cards stay lightweight until you expand them, so daily settings work does not pull heavy configs into the view."
        action={
          <Link to="/settings/mcp/installed" className="ns-btn ghost tiny">
            Installed MCPs
          </Link>
        }
      />

      <SectionCard>
        <div
          style={{
            padding: 14,
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 1fr) auto',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <label style={{ position: 'relative', display: 'block' }}>
            <span
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 24,
                height: 24,
                borderRadius: 999,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-indigo)',
                background:
                  'color-mix(in oklch, var(--color-indigo) 10%, transparent)',
                border:
                  '1px solid color-mix(in oklch, var(--color-indigo) 18%, transparent)',
                pointerEvents: 'none',
              }}
            >
              <Icons.search size={13} />
            </span>
            <input
              className="ns-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search resources..."
              style={{
                height: 44,
                paddingLeft: 44,
                borderRadius: 999,
                background:
                  'linear-gradient(180deg, color-mix(in oklch, white 92%, transparent), color-mix(in oklch, var(--color-paper) 80%, transparent))',
                borderColor:
                  'color-mix(in oklch, var(--color-indigo) 10%, var(--color-rule))',
                boxShadow:
                  'inset 0 1px 0 rgba(255,255,255,0.7), 0 10px 24px -20px rgba(14,17,22,0.35)',
              }}
              aria-label="Search marketplace resources"
            />
          </label>
          <div role="tablist" aria-label="Resource type" style={{ display: 'flex', gap: 6 }}>
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={typeFilter === t}
                className={`ns-btn ghost tiny ${typeFilter === t ? 'primary' : ''}`}
                onClick={() => setTypeFilter(t)}
              >
                {t === 'all' ? 'All' : TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
      </SectionCard>

      <ul
        aria-label="Marketplace resources"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
          gap: 14,
        }}
      >
        {resources === null ? (
          <li style={{ gridColumn: '1 / -1', color: 'var(--color-muted)', padding: 18 }}>
            Loading...
          </li>
        ) : filtered.length === 0 ? (
          <li style={{ gridColumn: '1 / -1' }}>
            <SectionCard>
              <div style={{ padding: 28, color: 'var(--color-muted)', textAlign: 'center' }}>
                No matching resources.
              </div>
            </SectionCard>
          </li>
        ) : (
          filtered.map((r) => {
            const key = resourceKey(r)
            const expanded = open === key
            const detail = details[key]
            const installing = busy === `install:${key}`
            const detailLoading = busy === `detail:${key}`
            const canInstall = r.available && !r.installed && (r.type === 'skill' || isAdmin)
            return (
              <li key={key}>
                <article
                  style={{
                    background: '#fff',
                    border: '1px solid var(--color-rule)',
                    borderRadius: 12,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minHeight: 220,
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <ResourceGlyph resource={r} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <h2
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            margin: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {r.name}
                        </h2>
                        {r.verified && <span className="tag teal" style={{ fontSize: 10 }}>verified</span>}
                      </div>
                      <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--color-muted)', marginTop: 2 }}>
                        {TYPE_LABEL[r.type]} · {r.publisher}
                        {r.version ? ` · v${r.version}` : ''}
                      </div>
                    </div>
                    <span className={`tag ${r.installed ? 'teal' : r.available ? 'indigo' : 'warn'}`} style={{ fontSize: 10 }}>
                      {r.installed ? 'installed' : r.available ? r.category : 'unavailable'}
                    </span>
                  </div>

                  <p style={{ margin: 0, color: 'var(--color-ink-2)', fontSize: 13, lineHeight: 1.5 }}>
                    {r.description}
                  </p>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {r.badges.slice(0, 4).map((b) => (
                      <span key={b} className="tag" style={{ fontSize: 10 }}>
                        {b}
                      </span>
                    ))}
                    {r.install_count && (
                      <span className="tag" style={{ fontSize: 10 }}>
                        {r.install_count} installs
                      </span>
                    )}
                    {typeof r.rating === 'number' && r.rating > 0 && (
                      <span className="tag" style={{ fontSize: 10 }}>
                        {r.rating.toFixed(1)}
                      </span>
                    )}
                  </div>

                  <div style={{ marginTop: 'auto', display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="ns-btn ghost tiny"
                      onClick={() => void loadDetail(r)}
                      aria-expanded={expanded}
                    >
                      {expanded ? 'Hide details' : detailLoading ? 'Loading...' : 'Details'}
                    </button>
                    <button
                      type="button"
                      className="ns-btn primary tiny"
                      disabled={!canInstall || installing}
                      onClick={() => void install(r)}
                      title={!isAdmin && r.type !== 'skill' ? 'Admin required' : undefined}
                    >
                      {r.installed
                        ? 'Installed'
                        : !r.available
                          ? 'Unavailable'
                          : installing
                            ? 'Installing...'
                            : 'Install'}
                    </button>
                  </div>

                  {expanded && (
                    <DetailPanel detail={detail} loading={detailLoading} />
                  )}
                </article>
              </li>
            )
          })
        )}
      </ul>
    </PageScaffold>
  )
}

function resourceKey(r: Pick<MarketplaceSummary, 'type' | 'id'>): string {
  return `${r.type}:${r.id}`
}

function summaryFromDetail(d: MarketplaceDetail): MarketplaceSummary {
  return {
    id: d.id,
    type: d.type,
    name: d.name,
    description: d.description,
    publisher: d.publisher,
    category: d.category,
    version: d.version,
    verified: d.verified,
    available: d.available,
    installed: d.installed,
    enabled: d.enabled,
    rating: d.rating,
    install_count: d.install_count,
    badges: d.badges,
  }
}

function ResourceGlyph({ resource }: { resource: MarketplaceSummary }) {
  const boxStyle = {
    width: 34,
    height: 34,
    borderRadius: 8,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: 'var(--color-paper-2)',
    color: 'var(--color-indigo)',
  }
  if (resource.type === 'mcp') {
    return (
      <span aria-hidden style={boxStyle}>
        <McpIcon name={resource.id} size={18} />
      </span>
    )
  }
  return (
    <span aria-hidden style={boxStyle}>
      {resource.type === 'skill' ? <Icons.sparkles size={15} /> : <Icons.folder size={15} />}
    </span>
  )
}

function DetailPanel({
  detail,
  loading,
}: {
  detail: MarketplaceDetail | undefined
  loading: boolean
}) {
  if (loading || !detail) {
    return (
      <div style={{ borderTop: '1px solid var(--color-rule)', paddingTop: 10, color: 'var(--color-muted)', fontSize: 12 }}>
        Loading details...
      </div>
    )
  }
  const triggers = Array.isArray(detail.details.triggers)
    ? (detail.details.triggers as Array<{ sample?: string }>)
    : []
  return (
    <div
      style={{
        borderTop: '1px solid var(--color-rule)',
        paddingTop: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {detail.install_notes && (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--color-ink-2)',
            background: 'color-mix(in oklch, var(--color-warn) 8%, transparent)',
            border: '1px solid color-mix(in oklch, var(--color-warn) 35%, transparent)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          {detail.install_notes}
        </div>
      )}

      {detail.permissions.length > 0 && (
        <div>
          <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-muted)', letterSpacing: '0.08em', marginBottom: 5 }}>
            PERMISSIONS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {detail.permissions.map((p) => (
              <div key={p} style={{ fontSize: 12, color: 'var(--color-ink-2)', lineHeight: 1.45 }}>
                {p}
              </div>
            ))}
          </div>
        </div>
      )}

      {triggers.length > 0 && (
        <div>
          <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-muted)', letterSpacing: '0.08em', marginBottom: 5 }}>
            TRIGGERS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {triggers.slice(0, 4).map((t, i) => (
              <code key={i} className="font-mono" style={{ fontSize: 11, background: 'var(--color-paper-2)', borderRadius: 5, padding: '4px 6px' }}>
                {t.sample}
              </code>
            ))}
          </div>
        </div>
      )}

      {detail.type === 'mcp' && (
        <pre
          className="font-mono"
          style={{
            margin: 0,
            maxHeight: 180,
            overflow: 'auto',
            background: 'var(--color-paper-2)',
            borderRadius: 8,
            padding: 10,
            fontSize: 10.5,
            lineHeight: 1.45,
          }}
        >
          {JSON.stringify(detail.details, null, 2)}
        </pre>
      )}
    </div>
  )
}
