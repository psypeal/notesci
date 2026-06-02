/**
 * Shared search input — used by the workspace SidePanel, the Draft
 * library, and the MCP marketplace so all three feel like the same
 * primitive. Wraps a leading magnifying-glass icon inside the pill
 * with consistent height, padding, focus halo, and placeholder
 * treatment.
 *
 * Sized to feel right in both dense pane chrome (SidePanel) and
 * roomier dashboard surfaces (MCP marketplace) — 38 px tall, 13.5 px
 * text. Use `style` to constrain max-width per surface.
 */
import { forwardRef, type CSSProperties } from 'react'
import { Icons } from './icons'

interface SearchBarProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className'
> {
  /** Constrain the bar's max width; defaults to filling the parent. */
  maxWidth?: number | string
  /** Override the wrapper inline style (e.g. flex sizing in toolbars). */
  containerStyle?: CSSProperties
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  function SearchBar({ maxWidth, containerStyle, style, ...rest }, ref) {
    return (
      <div
        className="ns-search"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: maxWidth ?? undefined,
          ...containerStyle,
        }}
      >
        <span aria-hidden className="ns-search-icon">
          <Icons.search size={14} />
        </span>
        <input
          ref={ref}
          type="search"
          className="ns-input ns-search-input"
          style={style}
          {...rest}
        />
      </div>
    )
  },
)
