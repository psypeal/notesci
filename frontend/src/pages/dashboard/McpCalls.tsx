import { useEffect, useId, useState } from 'react'
import { Link, useParams } from 'react-router'
import { LRow, PageHeader, PageScaffold, SectionCard } from '../../components/dashboard/PageScaffold'
import { Icons } from '../../components/icons'
import { api, errorMessage, type ApiError } from '../../lib/api'
import { useMe, userCard } from './useMe'

interface McpCall {
  id: number
  server_id: string
  tool_name: string
  arguments: Record<string, unknown> | null
  result_summary: string | null
  error: string | null
  duration_ms: number | null
  created_at: string
}

interface McpServer {
  id: string
  slug: string
  name: string
  transport: string
  enabled: boolean
}

const PAGE = 50

/**
 * Per-server MCP call log — backs the dashboard's installed-MCP detail
 * surface. Hits GET /mcp/servers/{id} for the header and
 * GET /mcp/servers/{id}/calls?limit&offset for the audit trail.
 */
export function McpCallsPage() {
  const { me } = useMe()
  const { id } = useParams<{ id: string }>()
  const [server, setServer] = useState<McpServer | null>(null)
  const [calls, setCalls] = useState<McpCall[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [srv, callsRes] = await Promise.all([
          api<McpServer>(`/mcp/servers/${id}`, { auth: true }),
          api<McpCall[]>(
            `/mcp/servers/${id}/calls?limit=${PAGE}&offset=${offset}`,
            { auth: true },
          ),
        ])
        setServer(srv)
        setCalls(callsRes)
        setHasMore(callsRes.length === PAGE)
      } catch (err) {
        const e = err as ApiError
        setError(
          e.code === 'mcp_not_found'
            ? "That MCP server isn't installed in this workspace."
            : errorMessage(err, `Couldn't load call log (${e.status}).`),
        )
      } finally {
        setLoading(false)
      }
    })()
  }, [id, offset, refreshTick])

  return (
    <PageScaffold
      active="mcp-installed"
      crumbs={['Settings', 'Connections', 'Installed MCPs', server?.name ?? 'Calls']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="CONNECTIONS · MCP CALL LOG"
        title={server ? server.name : 'Call log'}
        desc={
          server
            ? `Every tool invocation against ${server.name} (${server.slug}). Records what the agent called, what it got back, and how long it took.`
            : 'Tool-invocation audit log for this MCP server.'
        }
        action={
          <Link to="/settings/mcp/installed" className="ns-btn ghost tiny">
            ← All installed
          </Link>
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

      <SectionCard
        title={loading ? 'Loading…' : `${calls.length} calls${hasMore ? ' (more)' : ''}`}
        desc="Newest first. Truncated result summaries; full bodies aren't retained."
        action={
          <div role="toolbar" aria-label="Call log actions" style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="ns-btn ghost tiny"
              onClick={() => setRefreshTick((t) => t + 1)}
              disabled={loading}
              aria-busy={loading || undefined}
              aria-label="Refresh call log"
              title="Refresh"
            >
              <Icons.reset size={12} />
            </button>
            <button
              type="button"
              className="ns-btn ghost tiny"
              disabled={offset === 0 || loading}
              aria-busy={loading || undefined}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              ← Newer
            </button>
            <button
              type="button"
              className="ns-btn ghost tiny"
              disabled={!hasMore || loading}
              aria-busy={loading || undefined}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older →
            </button>
          </div>
        }
      >
        {calls.length === 0 && !loading ? (
          <div
            role="status"
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--color-muted)',
              fontSize: 13.5,
              lineHeight: 1.55,
            }}
          >
            <div style={{ marginBottom: 10 }} aria-hidden>
              <Icons.layers size={24} />
            </div>
            No calls yet. Tools from this server will show up here once the
            agent invokes them during a chat.
          </div>
        ) : (
          <ul
            aria-label="Tool call log"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {calls.map((c) => (
              <li key={c.id}>
                <CallRow call={c} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageScaffold>
  )
}

function CallRow({ call }: { call: McpCall }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const failed = !!call.error
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '1px solid var(--color-rule)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${call.tool_name} call from ${new Date(call.created_at).toLocaleString()}${call.error ? ' — failed' : ''}`}
        style={{
          display: 'grid',
          gridTemplateColumns: '160px 1fr 90px 90px 24px',
          gap: 18,
          padding: '14px 18px',
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'inherit',
        }}
      >
        <div
          className="font-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-muted)',
            letterSpacing: '0.04em',
          }}
        >
          {new Date(call.created_at).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </div>
        <div
          className="font-mono"
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {call.tool_name}
        </div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-muted)' }}>
          {typeof call.duration_ms === 'number' ? `${call.duration_ms} ms` : '—'}
        </div>
        <div>
          <span
            className={`tag ${failed ? 'danger' : 'teal'}`}
            style={{ fontSize: 10.5 }}
          >
            {failed ? 'ERROR' : '✓ OK'}
          </span>
        </div>
        <div
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            color: 'var(--color-muted)',
          }}
        >
          <Icons.chevRight size={14} />
        </div>
      </button>
      {open && (
        <div
          id={detailsId}
          style={{
            padding: '0 18px 14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <Block
            label="ARGUMENTS"
            value={
              call.arguments && Object.keys(call.arguments).length > 0
                ? JSON.stringify(call.arguments, null, 2)
                : '(no arguments)'
            }
          />
          {call.result_summary && (
            <Block label="RESULT (TRUNCATED)" value={call.result_summary} />
          )}
          {call.error && (
            <Block label="ERROR" value={call.error} tone="error" />
          )}
        </div>
      )}
    </div>
  )
}

function Block({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'error'
}) {
  return (
    <div>
      <div
        className="font-mono"
        style={{
          fontSize: 10.5,
          letterSpacing: '0.08em',
          color: 'var(--color-muted)',
          marginBottom: 4,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <pre
        className="font-mono"
        style={{
          fontSize: 11.5,
          background: tone === 'error'
            ? 'color-mix(in oklch, var(--color-error) 8%, transparent)'
            : 'var(--color-paper-2)',
          color: tone === 'error' ? 'var(--color-error)' : 'var(--color-ink)',
          padding: '8px 10px',
          borderRadius: 8,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: 0,
          maxHeight: 240,
          overflow: 'auto',
        }}
      >
        {value}
      </pre>
    </div>
  )
}

// Re-export for convenience to silence unused-import warnings if any.
export const _LRowProbe = LRow
