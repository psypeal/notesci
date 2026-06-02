import { Link } from 'react-router'
import { Lockup } from './brand/Lockup'

/**
 * Shown by Workspace + Dashboard pages on screens narrower than 900 px.
 * The 3-pane workspace and the rail-plus-content dashboard need real
 * desktop horizontal space; the auth flow is fully mobile.
 *
 * The notice is `display: none` above 900 px (see index.css), and
 * `display: flex` below — paired with `.hide-on-small` on the desktop
 * shell so we don't paint both.
 */
export function SmallScreenNotice({ where }: { where: 'workspace' | 'dashboard' }) {
  return (
    // `<main>` so AT users on narrow viewports still land on a page
    // landmark — the desktop shell's `<main>` is hidden by the same
    // `.hide-on-small` rule.
    <main className="small-screen-notice">
      <Lockup variant="split" size={24} />
      <div className="font-serif" style={{ fontSize: 24, color: 'var(--color-ink)', maxWidth: 280, lineHeight: 1.2 }}>
        Best on a wider screen.
      </div>
      <p style={{ maxWidth: 320, margin: 0 }}>
        notesci's {where === 'workspace' ? 'three-pane workspace' : 'settings rail'} is
        designed for desktop. Open this page from a laptop or larger
        tablet for the full experience.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 280, marginTop: 8 }}>
        <Link to="/invites" className="ns-btn full">
          Manage invites
        </Link>
        <Link to="/settings/profile" className="ns-btn ghost full">
          Profile settings
        </Link>
      </div>
    </main>
  )
}
