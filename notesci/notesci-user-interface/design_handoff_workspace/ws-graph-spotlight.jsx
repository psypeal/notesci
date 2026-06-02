// ws-graph-spotlight.jsx — large, dedicated frames that spotlight a single
// graph mode. Used in section 03 of the canvas.
const { GraphPane } = window;

const GRAPH_COPY = {
  citations: {
    title: "Citations",
    sub:   "Who cites whom — best for surveying a body of literature",
    legend: [
      ["referenced by latest answer", "var(--indigo)"],
      ["draft / note",                "var(--warn)"],
      ["everything else",             "var(--rule-2)"],
    ],
    use: "Use when you want to see how the papers in your project relate. Click any node to open the source in the reader.",
  },
  concepts: {
    title: "Concepts",
    sub:   "Topics extracted across your sources — best for spotting clusters & gaps",
    legend: [
      ["concept",                "var(--indigo)"],
      ["co-occurrence link",     "var(--rule-2)"],
    ],
    use: "Use early in a project to find what your collection is about. Click a concept to filter the graph and chat to just the sources that touch it.",
  },
  trail: {
    title: "Reasoning trail",
    sub:   "How the agent answered your last question — best for verifying the work",
    legend: [
      ["your question",          "var(--ink)"],
      ["agent step",             "var(--paper-2)"],
      ["source consulted",       "var(--indigo)"],
      ["final answer",           "var(--teal)"],
    ],
    use: "Use to audit any answer. Each step is replayable — open the step to see the exact prompt, retrieved chunks, and intermediate output.",
  },
};

const GraphSpotlight = ({ mode = "citations" }) => {
  const c = GRAPH_COPY[mode];
  return (
    <div style={{ width:1100, height:760, background:"var(--paper-3)", padding:24, display:"flex", flexDirection:"column", gap:14 }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-end", gap:14, padding:"0 4px" }}>
        <div className="mono" style={{ fontSize:11, letterSpacing:".12em", color:"var(--muted)" }}>GRAPH MODE · {mode.toUpperCase()}</div>
      </div>
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", padding:"0 4px", gap:24 }}>
        <div>
          <div className="serif" style={{ fontSize:34, fontWeight:500, lineHeight:1.05, letterSpacing:"-0.02em" }}>{c.title}</div>
          <div style={{ fontSize:14, color:"var(--ink-2)", marginTop:6, maxWidth:560, lineHeight:1.45 }}>{c.sub}</div>
        </div>
        <div style={{ maxWidth:380, fontSize:12.5, lineHeight:1.55, color:"var(--muted)", borderLeft:"2px solid var(--rule-2)", paddingLeft:14 }}>
          {c.use}
        </div>
      </div>

      {/* The graph itself, large */}
      <div style={{ flex:1, minHeight:0 }}>
        <GraphPane mode={mode} onMode={() => {}}/>
      </div>

      {/* Legend strip */}
      <div style={{ display:"flex", gap:18, padding:"6px 4px", flexWrap:"wrap" }}>
        {c.legend.map(([label, color]) => (
          <div key={label} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:"var(--ink-2)" }}>
            <span style={{ width:10, height:10, borderRadius:5, background:color }}/>
            {label}
          </div>
        ))}
      </div>
    </div>
  );
};

window.GraphSpotlight = GraphSpotlight;
