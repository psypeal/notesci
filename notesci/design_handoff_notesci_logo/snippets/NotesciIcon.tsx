// NotesciIcon.tsx — drop-in React component for the notesci icon.
// Single source of truth: change PALETTE.* to retune brand colors.

import * as React from "react";

type Pairing = "teal-indigo" | "indigo-violet" | "teal-violet" | "mono";

const PALETTE = {
  ink:    "#0e1116",
  paper:  "#f6f4ef",
  indigo: "oklch(0.52 0.22 274)",
  teal:   "oklch(0.62 0.14 195)",
  violet: "oklch(0.55 0.22 305)",
} as const;

const PAIRS: Record<Pairing, { N: string; S: string; hub: string; ringFill: string }> = {
  "teal-indigo":   { N: PALETTE.indigo, S: PALETTE.teal,   hub: PALETTE.ink, ringFill: PALETTE.paper },
  "indigo-violet": { N: PALETTE.indigo, S: PALETTE.violet, hub: PALETTE.ink, ringFill: PALETTE.paper },
  "teal-violet":   { N: PALETTE.violet, S: PALETTE.teal,   hub: PALETTE.ink, ringFill: PALETTE.paper },
  "mono":          { N: "currentColor", S: "currentColor", hub: "currentColor", ringFill: "transparent" },
};

export interface NotesciIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  pairing?: Pairing;
  title?: string;
}

export const NotesciIcon: React.FC<NotesciIconProps> = ({
  size = 32,
  pairing = "teal-indigo", // canonical brand pairing
  title = "notesci",
  ...rest
}) => {
  const c = PAIRS[pairing];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 96 96"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      {...rest}
    >
      <title>{title}</title>
      {/* N — two verticals + diagonal landing on shared hub */}
      <g fill="none" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 22 L22 70" stroke={c.N} />
        <path d="M22 22 L52 60" stroke={c.N} />
      </g>
      {/* S — single curve terminating at shared hub */}
      <path
        d="M76 30 C 76 20, 58 20, 58 32 C 58 42, 74 44, 74 54 C 74 66, 56 66, 52 60"
        fill="none"
        stroke={c.S}
        strokeWidth={8}
        strokeLinecap="round"
      />
      {/* Outer ring nodes */}
      <g fill={c.ringFill} strokeWidth={3}>
        <circle cx="22" cy="22" r="5" stroke={c.N} />
        <circle cx="22" cy="70" r="5" stroke={c.N} />
        <circle cx="76" cy="30" r="5" stroke={c.S} />
      </g>
      {/* Shared hub — visual anchor */}
      <circle cx="52" cy="60" r="6.5" fill={c.hub} />
    </svg>
  );
};

export default NotesciIcon;
