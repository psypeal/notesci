import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { initialsFor } from '../../lib/initials'

export interface MeOut {
  id: string
  workspace_id: string
  email: string
  display_name: string | null
  affiliation: string | null
  orcid: string | null
  field_of_research: string | null
  topics: string[]
  role: string
  email_verified: boolean
}

export function useMe() {
  const [me, setMe] = useState<MeOut | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    void (async () => {
      try {
        const m = await api<MeOut>('/me', { auth: true })
        setMe(m)
      } catch {
        // Caller's responsibility to redirect if 401.
      }
    })()
  }, [reload])
  return { me, refresh: () => setReload((n) => n + 1) }
}

export function avatarInitials(me: MeOut | null): string {
  return initialsFor(me?.display_name ?? null, me?.email ?? null)
}

export function userCard(me: MeOut | null) {
  return {
    name: me?.display_name ?? me?.email ?? 'Loading…',
    workspace: me?.workspace_id
      ? `Workspace · ${me.workspace_id.slice(0, 8)}`
      : '',
    initials: avatarInitials(me),
  }
}
