/**
 * Draft mode entry point. Acts as a tiny router between two surfaces:
 *
 *   - `DraftLibrary` — list of all drafts in this project (cards or
 *     list view), with a "+ New draft" button for ad-hoc quick notes.
 *   - `DraftEditor` — single-draft editor, opened when the user picks
 *     a card from the library or after creating a new draft.
 *
 * The selected draft id is persisted in localStorage per project so a
 * tab refresh lands the user back on the draft they were editing.
 */
import { useEffect, useState } from 'react'
import { DraftLibrary } from './DraftLibrary'
import { DraftEditor } from './DraftEditor'

function activeKey(projectId: string | null) {
  return `notesci_active_draft_${projectId ?? 'none'}`
}

export function DrafterPane({
  projectId,
}: {
  projectId?: string | null
} = {}) {
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(activeKey(projectId ?? null))
    } catch {
      return null
    }
  })

  // Project switch — reload the per-project "last open draft" pointer
  // (or clear it when the new project hasn't been opened before).
  useEffect(() => {
    try {
      setActiveId(localStorage.getItem(activeKey(projectId ?? null)))
    } catch {
      setActiveId(null)
    }
  }, [projectId])

  const open = (draftId: string) => {
    setActiveId(draftId)
    try {
      localStorage.setItem(activeKey(projectId ?? null), draftId)
    } catch {
      /* ignore */
    }
  }
  const back = () => {
    setActiveId(null)
    try {
      localStorage.removeItem(activeKey(projectId ?? null))
    } catch {
      /* ignore */
    }
  }

  if (activeId) {
    return (
      <DraftEditor
        draftId={activeId}
        onBack={back}
        onDelete={back}
      />
    )
  }
  return <DraftLibrary projectId={projectId ?? null} onOpen={open} />
}
