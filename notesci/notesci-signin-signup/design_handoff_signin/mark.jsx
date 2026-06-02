// mark.jsx — the refined notesci icon (concept 03 family)
//
// Design intent: an N and S monogram whose strokes meet at a shared node —
// "notes" + "science" converging into a single point of knowledge. Tuned
// for legibility down to favicon scale.
//
// Geometry decisions:
//  - 96×96 viewBox; mark sits in a 12-unit margin so it survives icon
//    masking systems that crop edges.
//  - N is built from two verticals + a diagonal that lands on the shared
//    node. Stroke is rounded for a friendly, modern feel.
//  - S is a single bezier path that mirrors the N's height; its bottom
//    terminus is the shared node, locking the two glyphs together.
//  - Nodes are mixed: the shared one is solid (anchor), the four
//    extremities are outlined rings (edges of the graph). Reads cleaner at
//    small sizes than all-solid dots and reinforces the graph metaphor.

const Mark = ({
  size = 96,
  // Two colors. `colorN` is the N stroke + its end nodes. `colorS` is the
  // S stroke + its end nodes. The shared connector node is `var(--ink)`.
  colorN = "var(--indigo)",
  colorS = "var(--teal)",
  hub = "var(--ink)",
  // ringStroke matches the corresponding glyph color
  bg = null, // optional background
  rounded = false, // wrap in a rounded square tile
  tileColor = "var(--ink)",
  tileFg = "white", // used when rounded=true
}) => {
  // When rendered as a tile, swap glyph colors to white and let the tile do
  // the color lifting.
  const cN = rounded ? tileFg : colorN;
  const cS = rounded ? "oklch(0.78 0.18 195)" : colorS; // brighter teal on dark
  const cH = rounded ? "oklch(0.78 0.18 130)" : hub;     // lime hub on dark

  const inner = (
    <g>
      {/* N: two verticals + diagonal landing on shared node */}
      <g fill="none" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 22 L22 70" stroke={cN} />
        <path d="M22 22 L52 60" stroke={cN} />
      </g>
      {/* S: single curve, terminates at shared node */}
      <path
        d="M76 30 C 76 20, 58 20, 58 32 C 58 42, 74 44, 74 54 C 74 66, 56 66, 52 60"
        fill="none"
        stroke={cS}
        strokeWidth="8"
        strokeLinecap="round"
      />
      {/* End-of-stroke nodes — outlined rings */}
      <g fill={rounded ? tileColor : "var(--paper)"} strokeWidth="3">
        <circle cx="22" cy="22" r="5" stroke={cN} />
        <circle cx="22" cy="70" r="5" stroke={cN} />
        <circle cx="76" cy="30" r="5" stroke={cS} />
      </g>
      {/* The shared "hub" node — solid, the visual anchor */}
      <circle cx="52" cy="60" r="6.5" fill={cH} />
    </g>
  );

  if (rounded) {
    return (
      <svg viewBox="0 0 96 96" width={size} height={size}>
        <rect x="2" y="2" width="92" height="92" rx="22" fill={tileColor} />
        {inner}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 96 96" width={size} height={size}>
      {bg && <rect x="0" y="0" width="96" height="96" rx="0" fill={bg} />}
      {inner}
    </svg>
  );
};

// Wordmark — three weight treatments. Wraps in a div so it can sit beside the mark.
const Wordmark = ({
  variant = "split",          // 'split' | 'accent' | 'uniform'
  size = 44,
  ink = "var(--ink)",
  muted = "var(--muted)",
  accent = "var(--teal)",
}) => {
  const base = {
    fontFamily: '"Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: size,
    letterSpacing: "-0.03em",
    lineHeight: 1,
    color: ink,
    display: "inline-flex",
    alignItems: "baseline",
  };
  if (variant === "split") {
    return (
      <span style={base}>
        <span style={{ fontWeight: 600 }}>note</span>
        <span style={{ fontWeight: 500, color: muted }}>sci</span>
      </span>
    );
  }
  if (variant === "accent") {
    return (
      <span style={base}>
        <span style={{ fontWeight: 500 }}>note</span>
        <span style={{ fontWeight: 500, color: accent }}>sci</span>
      </span>
    );
  }
  // uniform
  return (
    <span style={{ ...base, fontWeight: 600 }}>notesci</span>
  );
};

// Lockup — mark + wordmark side by side, with proper optical alignment
const Lockup = ({
  variant = "split",
  size = 44,
  gap = 16,
  colorN, colorS,
  ink = "var(--ink)",
  accent = "var(--teal)",
}) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap }}>
    <Mark size={size * 1.5} colorN={colorN} colorS={colorS} />
    <Wordmark variant={variant} size={size} ink={ink} accent={accent} />
  </div>
);

Object.assign(window, { Mark, Wordmark, Lockup });
