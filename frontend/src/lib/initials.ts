/**
 * Compute a 1–2 letter avatar label from a display name or email.
 * Splits on whitespace, `@`, and `.` so "Jin Park" → "JP" and
 * "jin@brown.edu" → "JB". Returns `·` (a neutral middle-dot) when no
 * usable letters exist — used as a placeholder while user data loads.
 */
export function initialsFor(
  displayName: string | null,
  email: string | null,
): string {
  const src = displayName ?? email ?? ''
  return (
    src
      .split(/[\s@.]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || '·'
  )
}
