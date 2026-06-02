import { Mark } from './Mark'
import { Wordmark } from './Wordmark'

/**
 * Mark + Wordmark side-by-side. Per design handoff: mark size = 1.5× the
 * wordmark font-size, 14–16px gap, x-height aligned (we use baseline
 * alignment which reads as x-height-aligned for these sizes).
 */
export function Lockup({
  variant = 'split',
  size = 20,
  gap = 14,
  colorN,
  colorS,
}: {
  variant?: 'split' | 'accent' | 'uniform'
  size?: number
  gap?: number
  colorN?: string
  colorS?: string
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap }}>
      <Mark size={size * 1.5} colorN={colorN} colorS={colorS} />
      <Wordmark variant={variant} size={size} />
    </div>
  )
}
