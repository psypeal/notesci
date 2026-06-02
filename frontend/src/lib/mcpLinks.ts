import { api, type ApiError } from './api'

export type ToastTone = 'info' | 'success' | 'warn' | 'error'

export interface McpLinkAction {
  handled: boolean
  open: boolean
  tone?: ToastTone
  message?: string
}

/**
 * Return a Notesci MCP install slug from a custom app URL.
 *
 * Supported form:
 *   - notesci://mcp/install/<id>
 */
function toNotesciInstallSlug(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'notesci:') {
      return null
    }

    const host = parsed.hostname.toLowerCase()
    const pathParts = parsed.pathname
      .split('/')
      .map((p) => p.toLowerCase())
      .filter(Boolean)

    if (pathParts[0] === 'mcp' && pathParts[1] === 'install' && pathParts[2]) {
      return pathParts[2]
    }

    const queryId = parsed.searchParams.get('id')
    if (queryId) {
      return queryId.toLowerCase().trim()
    }

    // Fallbacks for future-proofing: notesci://mcp/<id> or
    // notesci://install/<id>.
    if ((host === 'mcp' || host === 'install') && pathParts[0]) {
      return pathParts[pathParts.length - 1] || null
    }
  } catch {
    return null
  }

  return null
}

/**
 * Return a GitHub owner/repo slug from a URL.
 *
 * Accepts `https://github.com/owner/repo`, and URLs with a single-owner
 * path like `https://github.com/owner` for catalog entries that only expose
 * an org/user slug in the catalog.
 */
function toGithubRepoSlug(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null

    const [owner, repoRaw] = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)

    if (!owner) return null
    if (!repoRaw) {
      return owner.toLowerCase()
    }

    const repo = repoRaw.replace(/\.git$/i, '').toLowerCase()
    const ownerLower = owner.toLowerCase()

    return `${ownerLower}/${repo}`
  } catch {
    return null
  }
}

/**
 * If `url` points to a catalog MCP (GitHub repo URL or Notesci app URL),
 * attempt to install it.
 *
 * `handled` is true when the URL was recognized as an MCP link and we
 * either installed it, found it already installed, or reported a clear
 * reason why it can't be installed automatically. In that case callers
 * should use `open: false` to avoid sending users to external pages for
 * installation.
 */
export async function handleMcpLinkInstall(url: string): Promise<McpLinkAction> {
  const isMcpLink = toNotesciInstallSlug(url) || toGithubRepoSlug(url)
  if (!isMcpLink) {
    return { handled: false, open: true }
  }

  try {
    const installed = await api<{ name: string }>('/mcp/install-from-link', {
      method: 'POST',
      auth: true,
      body: JSON.stringify({ link: url }),
    })
    return {
      handled: true,
      open: false,
      tone: 'success',
      message: `${installed.name} was installed successfully. It should be available for this chat immediately.`,
    }
  } catch (err) {
    const e = err as ApiError
    if (e.code === 'mcp_already_installed' || e.status === 409) {
      return {
        handled: true,
        open: false,
        tone: 'info',
        message: 'This MCP is already installed for this workspace.',
      }
    }
    if (e.code === 'forbidden' || e.status === 403) {
      return {
        handled: true,
        open: false,
        tone: 'warn',
        message: 'Installing MCP servers requires workspace admin access.',
      }
    }
    if (e.code === 'catalog_entry_not_found' || e.status === 404) {
      return {
        handled: false,
        open: true,
      }
    }
    if (e.code === 'catalog_entry_unavailable' || e.status === 400) {
      return {
        handled: true,
        open: false,
        tone: 'warn',
        message: `The selected connector is not available in this catalog build yet.`,
      }
    }
    return {
      handled: true,
      open: false,
      tone: 'error',
      message: e.message || 'Couldn’t install that connector.',
    }
  }
}
