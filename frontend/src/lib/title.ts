import { useEffect } from 'react'

const BASE_TITLE = 'notesci'

/**
 * Sets `document.title` to "{title} · notesci" for the lifetime of the
 * mounting component, restoring the previous title on unmount. Call once
 * at the top of each route component.
 */
export function usePageTitle(title: string | null) {
  useEffect(() => {
    if (!title) return
    const prev = document.title
    document.title = `${title} · ${BASE_TITLE}`
    return () => {
      document.title = prev
    }
  }, [title])
}
