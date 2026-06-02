/**
 * Workspace icons — port of `ws-icons.jsx` from the design handoff.
 * Stroke-based, currentColor, 16px default.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const Icon = ({
  size = 16,
  fill = 'none',
  stroke = 'currentColor',
  strokeWidth = 1.6,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={stroke}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
    aria-hidden
    {...rest}
  >
    {children}
  </svg>
)

export const Icons = {
  search: (p?: IconProps) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  ),
  plus: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  chevDown: (p?: IconProps) => (
    <Icon {...p}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  ),
  chevRight: (p?: IconProps) => (
    <Icon {...p}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  ),
  folder: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  ),
  pdf: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </Icon>
  ),
  note: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M9 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4" />
      <path d="m18 2 4 4-9 9-4 1 1-4z" />
    </Icon>
  ),
  doc: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Icon>
  ),
  starFill: (p?: IconProps) => (
    <Icon fill="currentColor" stroke="none" {...p}>
      <path d="m12 3 2.7 5.5 6 .9-4.4 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3 9.4l6-.9z" />
    </Icon>
  ),
  send: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </Icon>
  ),
  thumbUp: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M7 10v11" />
      <path d="M18 21H7V10l5-7a2 2 0 0 1 2 2v5h4.5a2 2 0 0 1 2 2.3l-1.4 6a2 2 0 0 1-2 1.7z" />
    </Icon>
  ),
  thumbDown: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M17 14V3" />
      <path d="M6 3h11v11l-5 7a2 2 0 0 1-2-2v-5H5.5a2 2 0 0 1-2-2.3l1.4-6a2 2 0 0 1 2-1.7z" />
    </Icon>
  ),
  attach: (p?: IconProps) => (
    <Icon {...p}>
      <path d="m21 12-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8.5-8.5" />
    </Icon>
  ),
  slash: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M16 4 8 20" />
    </Icon>
  ),
  bot: (p?: IconProps) => (
    <Icon {...p}>
      <rect x="3" y="8" width="18" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </Icon>
  ),
  user: (p?: IconProps) => (
    <Icon {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Icon>
  ),
  pin: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M12 17v5" />
      <path d="m9 12 3 3 3-3 4-4-6-6-4 4z" />
    </Icon>
  ),
  kebab: (p?: IconProps) => (
    <Icon {...p}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Icon>
  ),
  filter: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M3 5h18l-7 9v6l-4-2v-4z" />
    </Icon>
  ),
  reset: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </Icon>
  ),
  layers: (p?: IconProps) => (
    <Icon {...p}>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </Icon>
  ),
  eye: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  ),
  share: (p?: IconProps) => (
    <Icon {...p}>
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="m8.5 10.5 7-3M8.5 13.5l7 3" />
    </Icon>
  ),
  arrowsOut: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M3 9V3h6M21 15v6h-6M3 3l7 7M21 21l-7-7" />
    </Icon>
  ),
  sparkles: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </Icon>
  ),
  gift: (p?: IconProps) => (
    <Icon {...p}>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M19 12v9H5v-9" />
      <path d="M7.5 8a2.5 2.5 0 1 1 4-3 2.5 2.5 0 1 1 5 3" />
    </Icon>
  ),
  logout: (p?: IconProps) => (
    <Icon {...p}>
      {/* "rightward door" — box on the left, arrow leaving through the right */}
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </Icon>
  ),
  download: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Icon>
  ),
  copy: (p?: IconProps) => (
    <Icon {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  ),
  trash: (p?: IconProps) => (
    <Icon {...p}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  ),
} as const
