import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Mark } from '../brand/Mark'
import { Icons } from '../icons'
import { SmallScreenNotice } from '../SmallScreenNotice'
import { usePageTitle } from '../../lib/title'

export type DashId =
  | 'profile'
  | 'preferences'
  | 'notifications'
  | 'privacy'
  | 'audit'
  | 'marketplace'
  | 'sources'
  | 'mcp-installed'
  | 'models'
  | 'skills'
  | 'memory'
  | 'citations'
  | 'library'
  | 'shortcuts'
  | 'changelog'

interface NavItem {
  id: DashId
  label: string
  href: string
  icon: keyof typeof Icons
  badge?: string
  pill?: string
}

/** Routable roots for the first crumb. Other crumbs are non-clickable
 * sub-section labels (e.g. "Connections", "Research"), so this map only
 * covers the entries we actually have a destination for. */
const CRUMB_HREF = {
  Settings: '/settings',
  Library: '/library',
} as const

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'GENERAL',
    items: [
      { id: 'profile', label: 'Profile', href: '/settings/profile', icon: 'user' },
      { id: 'preferences', label: 'Preferences', href: '/settings/preferences', icon: 'sparkles' },
      { id: 'notifications', label: 'Notifications', href: '/settings/notifications', icon: 'send' },
    ],
  },
  {
    section: 'CONNECTIONS',
    items: [
      { id: 'marketplace', label: 'Marketplace', href: '/settings/marketplace', icon: 'sparkles', pill: 'Browse' },
      { id: 'sources', label: 'Sources', href: '/settings/sources', icon: 'folder' },
      { id: 'mcp-installed', label: 'MCP servers', href: '/settings/mcp/installed', icon: 'share' },
      { id: 'models', label: 'Models & keys', href: '/settings/models', icon: 'sparkles' },
    ],
  },
  {
    section: 'RESEARCH',
    items: [
      { id: 'skills', label: 'Skills', href: '/settings/skills', icon: 'sparkles' },
      { id: 'memory', label: 'Memory', href: '/settings/memory', icon: 'doc' },
      { id: 'citations', label: 'Citations & export', href: '/settings/citations', icon: 'doc' },
    ],
  },
  {
    section: 'LIBRARY',
    items: [
      { id: 'library', label: 'All projects', href: '/library', icon: 'folder' },
    ],
  },
  {
    section: 'HELP',
    items: [
      { id: 'shortcuts', label: 'Keyboard shortcuts', href: '/settings/shortcuts', icon: 'slash' },
      { id: 'changelog', label: "What's new", href: '/settings/changelog', icon: 'sparkles' },
    ],
  },
]

interface UserCard {
  name: string
  workspace: string
  initials: string
}

/**
 * Dashboard page scaffold: top bar (Mark + breadcrumbs + back-to-workspace +
 * BETA pill + avatar), left rail with grouped nav, scrollable content area
 * with max-width 1100. Mirrors `PageScaffold` / `DBTopBar` / `DBRail` from
 * the design handoff's `db-chrome.jsx`.
 */
export function PageScaffold({
  active,
  crumbs,
  user,
  children,
}: {
  active: DashId
  crumbs: string[]
  user: UserCard
  children: ReactNode
}) {
  usePageTitle(crumbs[crumbs.length - 1] ?? 'Settings')
  return (
    <>
      <SmallScreenNotice where="dashboard" />
      <div
        className="hide-on-small"
        style={{
          background: 'var(--color-paper-3)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
      <DBTopBar crumbs={crumbs} initials={user.initials} />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <DBRail active={active} user={user} />
        <main
          id="main"
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '28px 36px',
            width: '100%',
          }}
        >
          <div style={{ maxWidth: 1100, margin: '0 auto' }}>{children}</div>
        </main>
      </div>
      </div>
    </>
  )
}

function DBTopBar({ crumbs, initials }: { crumbs: string[]; initials: string }) {
  return (
    <header
      style={{
        height: 48,
        background: '#fff',
        borderBottom: '1px solid var(--color-rule)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: 14,
        fontSize: 13,
        color: 'var(--color-ink)',
        flexShrink: 0,
      }}
    >
      <Link
        to="/"
        aria-label="Back to workspace"
        title="Back to workspace"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          textDecoration: 'none',
          color: 'inherit',
          borderRadius: 6,
        }}
      >
        <Mark size={26} />
      </Link>
      <div
        aria-hidden
        style={{
          width: 1,
          height: 18,
          background: 'var(--color-rule)',
          marginLeft: 4,
        }}
      />
      <Link
        to="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--color-ink-2)',
          textDecoration: 'none',
          fontSize: 12.5,
        }}
      >
        <span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}>
          <Icons.chevRight size={12} />
        </span>{' '}
        Back to workspace
      </Link>
      <div aria-hidden style={{ width: 1, height: 18, background: 'var(--color-rule)' }} />
      <nav
        aria-label="Breadcrumb"
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
      >
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          const linkTarget = i === 0 ? CRUMB_HREF[c as keyof typeof CRUMB_HREF] : undefined
          const labelStyle = {
            color: isLast ? 'var(--color-ink)' : 'var(--color-muted)',
            fontWeight: isLast ? 500 : 400,
          }
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span style={{ color: 'var(--color-muted-2)' }}>/</span>}
              {linkTarget && !isLast ? (
                <Link to={linkTarget} style={{ ...labelStyle, textDecoration: 'none' }}>
                  {c}
                </Link>
              ) : (
                <span style={labelStyle} aria-current={isLast ? 'page' : undefined}>
                  {c}
                </span>
              )}
            </span>
          )
        })}
      </nav>
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            background: 'var(--color-indigo)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {initials}
        </div>
      </div>
    </header>
  )
}

function DBRail({ active, user }: { active: DashId; user: UserCard }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [acctOpen, setAcctOpen] = useState(false)
  const acctRef = useRef<HTMLDivElement | null>(null)
  const acctTriggerRef = useRef<HTMLButtonElement | null>(null)
  const acctMenuId = useId()
  useEffect(() => {
    if (!acctOpen) return
    const onDoc = (e: MouseEvent) => {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) {
        setAcctOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAcctOpen(false)
        // Return focus to trigger so keyboard users keep their place.
        acctTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [acctOpen])
  return (
    <nav
      aria-label="Settings navigation"
      style={{
        width: 248,
        background: 'var(--color-paper)',
        borderRight: '1px solid var(--color-rule)',
        height: '100%',
        overflowY: 'auto',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ flex: 1 }}>
        {NAV.map((group) => {
          const groupId = `dbnav-${group.section.toLowerCase()}`
          return (
            <div key={group.section}>
              <div id={groupId} className="group-label">
                {group.section}
              </div>
              <ul
                role="list"
                aria-labelledby={groupId}
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: '0 8px 6px',
                }}
              >
                {group.items.map((item) => {
                  const Icon = Icons[item.icon]
                  const isActive =
                    item.id === active || location.pathname === item.href
                  return (
                    <li key={item.id}>
                      <Link
                        to={item.href}
                        aria-current={isActive ? 'page' : undefined}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div
                          className={`row ${isActive ? 'active' : ''}`}
                          style={{ padding: '7px 10px', fontSize: 13 }}
                        >
                          <Icon size={14} />
                          <span style={{ flex: 1 }}>{item.label}</span>
                          {item.badge && (
                            <span className="tag" style={{ fontSize: 10, padding: '1px 6px' }}>
                              {item.badge}
                            </span>
                          )}
                          {item.pill && (
                            <span className="tag indigo" style={{ fontSize: 10, padding: '1px 6px' }}>
                              {item.pill}
                            </span>
                          )}
                        </div>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
      <div
        ref={acctRef}
        style={{
          position: 'relative',
          background: 'var(--color-paper)',
          borderTop: '1px solid var(--color-rule)',
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <div className="avatar" aria-hidden>{user.initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {user.name}
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--color-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {user.workspace}
          </div>
        </div>
        <button
          ref={acctTriggerRef}
          type="button"
          onClick={() => setAcctOpen((o) => !o)}
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={acctOpen}
          aria-controls={acctMenuId}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-muted)',
            padding: 4,
            borderRadius: 4,
          }}
        >
          <Icons.kebab size={14} />
        </button>
        {acctOpen && (
          <div
            id={acctMenuId}
            role="menu"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              right: 8,
              minWidth: 200,
              background: '#fff',
              border: '1px solid var(--color-rule)',
              borderRadius: 10,
              boxShadow: '0 16px 32px rgba(0,0,0,0.14)',
              zIndex: 30,
              padding: 6,
            }}
          >
            <RailMenuItem
              icon={<Icons.user size={12} />}
              label="Profile"
              onClick={() => {
                setAcctOpen(false)
                navigate('/settings/profile')
              }}
            />
            <RailMenuItem
              icon={<Icons.eye size={12} />}
              label="Open workspace"
              onClick={() => {
                setAcctOpen(false)
                navigate('/')
              }}
            />
          </div>
        )}
      </div>
    </nav>
  )
}

function RailMenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="ns-menu-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        width: '100%',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        borderRadius: 6,
        color: destructive ? 'var(--color-error)' : 'inherit',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

export function PageHeader({
  eyebrow,
  title,
  desc,
  action,
}: {
  eyebrow: string
  title: ReactNode
  desc: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 24,
        marginBottom: 18,
      }}
    >
      <div style={{ flex: 1 }}>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="title">{title}</h1>
        <div className="desc">{desc}</div>
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  )
}

export function SectionCard({
  title,
  desc,
  action,
  children,
}: {
  title?: ReactNode
  desc?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="section-card">
      {(title || action) && (
        <div className="section-card-header">
          <div style={{ flex: 1 }}>
            {title && <h2 className="section-card-title">{title}</h2>}
            {desc && <p className="section-card-desc">{desc}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

export function LRow({
  label,
  value,
  help,
  action,
}: {
  label: string
  value: ReactNode
  help?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="lrow">
      <div className="lrow-label">{label}</div>
      <div className="lrow-value">
        <div>{value}</div>
        {help && <div className="lrow-help">{help}</div>}
      </div>
      <div>{action}</div>
    </div>
  )
}
