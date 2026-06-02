/**
 * Format a timestamp as a relative-to-now string. Accepts a Date, an ms
 * epoch number, or an ISO string. Returns:
 *   - "just now" when the diff is under 1.5s (or 1m if seconds=false)
 *   - "{N}s ago" when seconds=true and diff < 60s
 *   - "{N}m ago" / "{N}h ago" / "{N}d ago" otherwise
 *
 * Used across Drafter (`saved X ago`), Reader (annotation timestamps),
 * and SidePanel (session last-updated).
 */
export function relativeTime(
  when: Date | number | string,
  options: { seconds?: boolean } = {},
): string {
  const ts =
    typeof when === 'number'
      ? when
      : typeof when === 'string'
        ? new Date(when).getTime()
        : when.getTime()
  const diff = Math.max(0, Date.now() - ts)
  if (options.seconds) {
    if (diff < 1500) return 'just now'
    const s = Math.round(diff / 1000)
    if (s < 60) return `${s}s ago`
  }
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
