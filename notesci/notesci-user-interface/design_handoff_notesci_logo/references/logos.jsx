// logos.jsx — eight notesci lettermark explorations
// Each logo is rendered as an SVG so it scales cleanly. They share a baseline
// of geometry (an N or NS monogram) and are differentiated by how the
// "knowledge graph" metaphor is expressed.

// Reusable node primitive
const Node = ({ cx, cy, r = 5, fill, stroke, strokeWidth = 0 }) => (
  <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
);

// 01 — N as a connected path between three nodes
// The N's three apexes are literally graph nodes; the strokes between them
// are graph edges. The simplest, most direct expression of the brief.
const Logo01 = ({ size = 96, color = "var(--indigo)" }) => (
  <svg viewBox="0 0 96 96" width={size} height={size}>
    <g stroke={color} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M22 74 L22 22 L74 74 L74 22" />
    </g>
    <g fill={color}>
      <circle cx="22" cy="22" r="8" />
      <circle cx="74" cy="22" r="8" />
      <circle cx="22" cy="74" r="8" />
      <circle cx="74" cy="74" r="8" />
    </g>
  </svg>
);

// 02 — N as the diagonal of a 3x3 graph lattice
// The diagonal stroke of the N is highlighted; surrounding nodes are dimmed.
// Reads as "your note in a network of related work."
const Logo02 = ({ size = 96, color = "var(--indigo)" }) => {
  const nodes = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    nodes.push({ x: 18 + c * 20, y: 18 + r * 20, r, c });
  }
  const onN = (r, c) => (c === 0) || (c === 3) || (r === c);
  return (
    <svg viewBox="0 0 96 96" width={size} height={size}>
      {/* faint edges */}
      <g stroke={color} strokeOpacity="0.15" strokeWidth="1.5">
        {nodes.map((n, i) => nodes.slice(i + 1).map((m, j) => {
          const dist = Math.hypot(n.x - m.x, n.y - m.y);
          if (dist > 22) return null;
          return <line key={`${i}-${j}`} x1={n.x} y1={n.y} x2={m.x} y2={m.y} />;
        }))}
      </g>
      {/* N path */}
      <path d="M18 78 L18 18 L78 78 L78 18"
            stroke={color} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* highlighted node dots */}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={onN(n.r, n.c) ? 4 : 2.2}
                fill={onN(n.r, n.c) ? color : color}
                opacity={onN(n.r, n.c) ? 1 : 0.25} />
      ))}
    </svg>
  );
};

// 03 — NS monogram as two overlapping nodes (Venn-style citation)
// N and S share a node where they cross; reads as "notes" + "science"
// converging.
const Logo03 = ({ size = 96, color = "var(--teal)", color2 = "var(--indigo)" }) => (
  <svg viewBox="0 0 96 96" width={size} height={size}>
    <g fill="none" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
      {/* N */}
      <path d="M20 72 L20 24 L52 64" stroke={color2} />
      {/* S curve */}
      <path d="M76 30 C 76 20, 56 20, 56 32 C 56 44, 76 44, 76 56 C 76 68, 56 68, 56 60"
            stroke={color} />
    </g>
    <g>
      <circle cx="20" cy="24" r="6" fill={color2} />
      <circle cx="20" cy="72" r="6" fill={color2} />
      {/* shared connector node */}
      <circle cx="52" cy="64" r="7" fill="var(--ink)" />
      <circle cx="76" cy="30" r="6" fill={color} />
      <circle cx="76" cy="56" r="6" fill={color} />
    </g>
  </svg>
);

// 04 — Geometric N inside a hex tile (looks like a molecular cell)
// A hexagon (chemistry/structure) holds an inset N. Bridges "scientific" and
// "knowledge node" without being literal about beakers.
const Logo04 = ({ size = 96, color = "var(--violet)" }) => (
  <svg viewBox="0 0 96 96" width={size} height={size}>
    <polygon points="48,8 84,28 84,68 48,88 12,68 12,28"
             fill="none" stroke={color} strokeWidth="4.5" strokeLinejoin="round" />
    <path d="M30 70 L30 30 L66 70 L66 30"
          stroke={color} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    {/* small accent nodes at hex vertices */}
    <circle cx="48" cy="8" r="3.5" fill={color} />
    <circle cx="48" cy="88" r="3.5" fill={color} />
  </svg>
);

// 05 — N constructed from connecting paths (two-tone gradient, curved corners)
// Friendlier, more "SaaS-y" — uses a stroke gradient to feel modern, with
// node pucks at the joints. Bevelled inner corner reads as a writing/cursor
// notch.
const Logo05 = ({ size = 96, idSuffix = "a" }) => {
  const id = `g-${idSuffix}`;
  return (
    <svg viewBox="0 0 96 96" width={size} height={size}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.55 0.22 274)" />
          <stop offset="100%" stopColor="oklch(0.62 0.14 195)" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="84" height="84" rx="20" fill={`url(#${id})`} />
      <path d="M28 70 L28 30 Q28 26 32 26 L34 26 Q38 26 41 30 L62 60 L62 30 Q62 26 66 26 L68 26"
            stroke="white" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="28" cy="26" r="3.5" fill="white" />
      <circle cx="68" cy="70" r="3.5" fill="white" />
    </svg>
  );
};

// 06 — Constellation N: nodes joined by thin lines (very "knowledge-graph")
// Ten nodes positioned to trace an N; thin edges connect them in sequence
// with one cross-edge to suggest network. Light, airy, scientific.
const Logo06 = ({ size = 96, color = "var(--indigo)" }) => {
  const pts = [
    [20, 76], [20, 56], [20, 36], [20, 18],
    [38, 38], [56, 58], [74, 78],
    [74, 58], [74, 38], [74, 18],
  ];
  // draw zigzag N
  const linePath = "M20,76 L20,18 L74,78 L74,18";
  return (
    <svg viewBox="0 0 96 96" width={size} height={size}>
      <path d={linePath} stroke={color} strokeWidth="2" strokeOpacity="0.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {/* cross-edges that suggest a graph (not just a glyph) */}
      <g stroke={color} strokeOpacity="0.25" strokeWidth="1.2">
        <line x1="20" y1="36" x2="74" y2="38" />
        <line x1="20" y1="56" x2="74" y2="58" />
      </g>
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 0 || i === 3 || i === 6 || i === 9 ? 5 : 3.5} fill={color} />
      ))}
    </svg>
  );
};

// 07 — NS ligature in a square tile (app-icon ready)
// A solid-fill rounded square containing an N that morphs into an S via a
// shared cross-stroke. Designed to read at favicon size.
const Logo07 = ({ size = 96 }) => (
  <svg viewBox="0 0 96 96" width={size} height={size}>
    <rect x="6" y="6" width="84" height="84" rx="22" fill="var(--ink)" />
    <g stroke="white" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M24 70 L24 26 L52 60" />
      <path d="M72 30 Q60 22 54 32 Q50 42 64 46 Q78 50 72 62 Q66 72 54 66" />
    </g>
    <circle cx="24" cy="26" r="4" fill="oklch(0.62 0.14 195)" />
    <circle cx="72" cy="62" r="4" fill="oklch(0.62 0.14 195)" />
  </svg>
);

// 08 — Annotation N: an N built from a highlighted/marked text gesture
// A blocky N sits on top of a soft "highlighter" rectangle — references the
// note-taking side of the product. The highlight is an oklch tint.
const Logo08 = ({ size = 96, color = "var(--violet)" }) => (
  <svg viewBox="0 0 96 96" width={size} height={size}>
    <rect x="14" y="48" width="68" height="22" rx="3" fill="oklch(0.92 0.08 130)" />
    <path d="M22 76 L22 20 L74 76 L74 20"
          stroke={color} strokeWidth="9" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
    <circle cx="74" cy="20" r="6" fill={color} />
  </svg>
);

// ───────────── Lockups ─────────────
// Standard mark + wordmark
const Lockup = ({ Mark, color = "var(--ink)", scale = 1, accent }) => (
  <div className="lockup" style={{ transform: `scale(${scale})` }}>
    <Mark size={64} color={color} color2={accent || color} />
    <div className="word">
      note<span className="sci">sci</span>
    </div>
  </div>
);

// Big centered hero mark (mark over wordmark)
const Hero = ({ Mark, color, accent, label }) => (
  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:18 }}>
    <Mark size={160} color={color} color2={accent || color} />
    <div style={{ fontSize: 44, letterSpacing: "-0.03em", fontWeight: 600 }}>
      note<span style={{ color: "var(--muted)", fontWeight: 500 }}>sci</span>
    </div>
  </div>
);

Object.assign(window, {
  Logo01, Logo02, Logo03, Logo04, Logo05, Logo06, Logo07, Logo08,
  Lockup, Hero,
});
