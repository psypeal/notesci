// ws-panes.jsx — the three primary panes (left, chat, graph) plus
// reader & drafter used in alt modes.

const { Mark, Lockup } = window;
const { PROJECT, PROJECTS, SESSIONS, MATERIALS, MATERIALS_INDEX, MESSAGES, SCOPED_SOURCES } = window;
const { Icons } = window;

// ─────────── Top bar (global chrome) ───────────
const TopBar = ({ layout = "default", onLayout = () => {} }) => (
  <div style={{ height:48, background:"#fff", borderBottom:"1px solid var(--rule)", display:"flex", alignItems:"center", padding:"0 14px", gap:14, fontSize:13, color:"var(--ink)" }}>
    <Mark size={26} colorN="var(--indigo)" colorS="var(--teal)"/>
    <div style={{ width:1, height:18, background:"var(--rule)", marginLeft:4 }}/>
    {/* Project switcher */}
    <button className="row" style={{ padding:"5px 10px", borderRadius:6, fontSize:13 }}>
      <span style={{ fontWeight:500 }}>{PROJECT.name}</span>
      <Icons.chevDown size={14}/>
    </button>
    {/* Layout-mode switcher */}
    <div style={{ display:"flex", padding:3, background:"var(--paper-2)", borderRadius:8, border:"1px solid var(--rule)", marginLeft:4 }}>
      {[
        ["default","Default"],
        ["reading","Reading"],
        ["drafting","Drafting"],
      ].map(([id, label]) => (
        <button key={id} onClick={() => onLayout(id)}
          style={{ padding:"4px 10px", fontSize:11.5, borderRadius:6, border:"none", background: layout === id ? "var(--ink)" : "transparent", color: layout === id ? "var(--paper)" : "var(--ink-2)", cursor:"pointer", fontFamily:"inherit" }}>
          {label}
        </button>
      ))}
    </div>
    {/* Search / command */}
    <div style={{ flex:1, display:"flex", justifyContent:"center" }}>
      <div style={{ width:520, display:"flex", alignItems:"center", gap:8, padding:"6px 10px", border:"1px solid var(--rule)", borderRadius:8, background:"var(--paper-2)", color:"var(--muted)" }}>
        <Icons.search size={14}/>
        <span style={{ fontSize:12.5 }}>Search materials, sessions, or run a command…</span>
        <span style={{ marginLeft:"auto" }} className="mono">⌘K</span>
      </div>
    </div>
    {/* Right cluster */}
    <button className="ns-btn ghost tiny" style={{ gap:6 }}><Icons.share size={12}/> Share</button>
    <button className="ns-btn tiny"><Icons.sparkles size={12}/> New session</button>
    <div style={{ width:28, height:28, borderRadius:14, background:"var(--indigo)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:600 }}>JP</div>
  </div>
);

// ─────────── Left pane ───────────
const SidePanel = ({ width = 280 }) => (
  <div className="pane" style={{ width, borderRadius:0, borderLeft:"none", borderTop:"none", borderBottom:"none", background:"var(--paper)", height:"100%" }}>
    {/* project header */}
    <div style={{ padding:"14px 14px 10px", borderBottom:"1px solid var(--rule)" }}>
      <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)", marginBottom:4 }}>PROJECT</div>
      <div style={{ fontSize:14.5, fontWeight:500, lineHeight:1.25, marginBottom:8 }}>{PROJECT.name}</div>
      <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
        {PROJECT.tags.map(t => <span key={t} className="tag">#{t}</span>)}
        <span className="tag" style={{ borderStyle:"dashed", color:"var(--muted)" }}>+</span>
      </div>
    </div>
    {/* search */}
    <div style={{ padding:"10px 12px", borderBottom:"1px solid var(--rule)" }}>
      <div style={{ position:"relative" }}>
        <input className="ns-input" placeholder="Search this project…" style={{ paddingLeft:30 }}/>
        <span style={{ position:"absolute", left:9, top:9, color:"var(--muted)" }}><Icons.search size={14}/></span>
      </div>
    </div>

    {/* SESSIONS */}
    <div className="group-label">
      <Icons.chevDown size={12}/> Sessions
      <span className="count">{SESSIONS.length}</span>
      <button className="ns-btn ghost tiny" style={{ marginLeft:6, padding:"2px 6px" }}><Icons.plus size={12}/></button>
    </div>
    <div style={{ padding:"0 6px 6px" }}>
      {SESSIONS.map(s => (
        <div key={s.id} className={`row ${s.active ? "active" : ""}`} style={{ alignItems:"flex-start", padding:"7px 10px", lineHeight:1.3 }}>
          <span style={{ width:6, height:6, borderRadius:3, marginTop:6, background: s.active ? "var(--indigo)" : (s.draft ? "var(--warn)" : "var(--rule-2)") }}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ fontSize:13, color: s.active ? "var(--ink)" : "var(--ink-2)", fontWeight: s.active ? 500 : 400, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {s.title}
              </div>
              {s.pinned && <Icons.pin size={11}/>}
            </div>
            <div style={{ display:"flex", gap:8, fontSize:11, color:"var(--muted)", marginTop:2 }} className="mono">
              <span>{s.ago}</span>
              <span>·</span>
              <span>{s.n} msgs</span>
              {s.draft && <><span>·</span><span style={{ color:"var(--warn)" }}>DRAFT</span></>}
            </div>
          </div>
        </div>
      ))}
    </div>

    {/* MATERIALS */}
    <div className="group-label" style={{ marginTop:6 }}>
      <Icons.chevDown size={12}/> Materials
      <span className="count">{MATERIALS.reduce((n,f)=>n+f.count,0)}</span>
      <button className="ns-btn ghost tiny" style={{ marginLeft:6, padding:"2px 6px" }}><Icons.plus size={12}/></button>
    </div>
    {/* filter strip */}
    <div style={{ display:"flex", gap:6, padding:"0 14px 8px", flexWrap:"wrap" }}>
      <span className="tag solid" style={{ fontSize:10.5 }}>All</span>
      <span className="tag" style={{ fontSize:10.5 }}>★ Starred</span>
      <span className="tag" style={{ fontSize:10.5 }}>PDF</span>
      <span className="tag" style={{ fontSize:10.5 }}>Notes</span>
    </div>
    <div style={{ padding:"0 6px 14px" }}>
      {MATERIALS.map(folder => (
        <div key={folder.id}>
          <div className="row" style={{ padding:"5px 10px", color:"var(--ink)", fontWeight:500 }}>
            {folder.open ? <Icons.chevDown size={12}/> : <Icons.chevRight size={12}/>}
            <Icons.folder size={14}/>
            <span style={{ flex:1, fontSize:12.5 }}>{folder.name}</span>
            <span className="meta">{folder.count}</span>
          </div>
          {folder.open && folder.children.map(item => (
            <div key={item.id} className="row" style={{ padding:"5px 10px 5px 28px" }}>
              {item.type === "pdf"  && <Icons.pdf size={14}/>}
              {item.type === "note" && <Icons.note size={14}/>}
              {item.type === "doc"  && <Icons.doc size={14}/>}
              <span style={{ flex:1, fontSize:12.5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.name}</span>
              {item.starred && <span style={{ color:"var(--warn)" }}><Icons.starFill size={11}/></span>}
              <span className="meta">{item.year}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  </div>
);

// ─────────── Chat pane ───────────
const RenderText = ({ text, cites = [] }) => {
  // very small parser: replaces [n] with citation chips by index
  const parts = text.split(/(\[\d+\])/g);
  return <>{parts.map((p, i) => {
    const m = p.match(/^\[(\d+)\]$/);
    if (!m) return <React.Fragment key={i}>{p}</React.Fragment>;
    const n = parseInt(m[1], 10);
    const cite = cites.find(c => c.n === n);
    if (!cite) return p;
    const meta = MATERIALS_INDEX[cite.m];
    return <span key={i} className="cite" title={`${meta.name} · ${meta.year}`}>{n} {meta?.year}</span>;
  })}</>;
};

const ChatPane = ({ scopeChips = true, sources = SCOPED_SOURCES }) => (
  <div className="pane" style={{ height:"100%" }}>
    <div className="pane-header" style={{ borderBottom:"1px solid var(--rule)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ width:8, height:8, borderRadius:4, background:"var(--indigo)" }}/>
        <div>
          <div style={{ fontSize:13.5, fontWeight:500, lineHeight:1.2 }}>Where do induction heads emerge in small models?</div>
          <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em" }}>SESSION · STARTED 10:14 · 3 MESSAGES</div>
        </div>
      </div>
      <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
        <button className="ns-btn ghost tiny"><Icons.layers size={12}/> Save to graph</button>
        <button className="ns-btn ghost tiny"><Icons.eye size={12}/> Open reader</button>
        <button className="ns-btn ghost tiny" style={{ padding:"4px 6px" }}><Icons.kebab size={12}/></button>
      </div>
    </div>

    {/* Scope chips */}
    {scopeChips && (
      <div style={{ padding:"10px 14px", display:"flex", gap:6, alignItems:"center", borderBottom:"1px solid var(--rule)", background:"var(--paper-2)", flexWrap:"wrap" }}>
        <span className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)" }}>SOURCES IN SCOPE</span>
        {sources.map(s => (
          <span key={s.id} className="tag" style={{ background:"#fff", borderColor:"var(--rule-2)" }}>
            {s.kind === "pdf" ? <Icons.pdf size={10}/> : <Icons.note size={10}/>}
            {s.name}
            <span style={{ color:"var(--muted)", marginLeft:2 }}>×</span>
          </span>
        ))}
        <button className="tag" style={{ borderStyle:"dashed", color:"var(--muted)", cursor:"pointer", background:"transparent" }}><Icons.plus size={10}/> Add source</button>
        <span className="mono" style={{ marginLeft:"auto", fontSize:10, color:"var(--muted)" }}>{sources.length} of 23 in project</span>
      </div>
    )}

    {/* Messages */}
    <div className="pane-body" style={{ padding:"18px 22px 24px", display:"flex", flexDirection:"column", gap:18 }}>
      {MESSAGES.map((m, i) => (
        <div key={i} style={{ display:"flex", gap:12 }}>
          <div style={{ flexShrink:0, width:26, height:26, borderRadius:13, display:"flex", alignItems:"center", justifyContent:"center", background: m.who === "user" ? "var(--ink)" : "var(--indigo-soft)", color: m.who === "user" ? "var(--paper)" : "var(--indigo)" }}>
            {m.who === "user" ? <Icons.user size={13}/> : <Icons.bot size={13}/>}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:4 }}>
              <span style={{ fontSize:12.5, fontWeight:500 }}>{m.who === "user" ? "Jin Park" : "notesci"}</span>
              <span className="mono" style={{ fontSize:10.5, color:"var(--muted)" }}>{m.at}</span>
              {m.model && <span className="tag" style={{ fontSize:9.5, padding:"1px 6px" }}>{m.model}</span>}
            </div>
            <div className="serif" style={{ fontSize:14.5, lineHeight:1.55, color:"var(--ink)" }}>
              <RenderText text={m.text} cites={m.cites || []}/>
            </div>
            {m.who === "ai" && (
              <div style={{ display:"flex", gap:6, marginTop:10, alignItems:"center" }}>
                <button className="ns-btn ghost tiny">↑ helpful</button>
                <button className="ns-btn ghost tiny">↓</button>
                <button className="ns-btn ghost tiny"><Icons.layers size={11}/> Pin to graph</button>
                <button className="ns-btn ghost tiny"><Icons.doc size={11}/> Send to draft</button>
                <span className="mono" style={{ fontSize:10, color:"var(--muted)", marginLeft:"auto" }}>4 sources · 1.2s · thorough</span>
              </div>
            )}
          </div>
        </div>
      ))}
      {/* Streaming indicator */}
      <div style={{ display:"flex", gap:12, alignItems:"center", color:"var(--muted)", fontSize:12.5 }}>
        <div style={{ width:26, height:26, borderRadius:13, background:"var(--indigo-soft)", color:"var(--indigo)", display:"flex", alignItems:"center", justifyContent:"center" }}><Icons.bot size={13}/></div>
        <div style={{ display:"flex", gap:4 }}>
          {[0,1,2].map(i => <span key={i} style={{ width:6, height:6, borderRadius:3, background:"var(--indigo)", animation:"pulse 1.2s ease-in-out infinite", animationDelay:`${i*0.15}s` }}/>)}
        </div>
        <span className="mono" style={{ fontSize:10.5, letterSpacing:".06em" }}>READING OLSSON §3 · 2 OF 4 SOURCES</span>
      </div>
    </div>

    {/* Composer */}
    <div style={{ borderTop:"1px solid var(--rule)", padding:"12px 14px", background:"#fff" }}>
      <div style={{ display:"flex", flexDirection:"column", gap:8, padding:"8px 10px", border:"1px solid var(--rule-2)", borderRadius:10 }}>
        <textarea rows={2} placeholder="Ask anything about your sources, or type / for commands…" style={{ resize:"none", border:"none", outline:"none", font:"inherit", fontSize:13.5, color:"var(--ink)", background:"transparent" }} defaultValue=""/>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <button className="ns-btn ghost tiny"><Icons.attach size={12}/></button>
          <button className="ns-btn ghost tiny"><Icons.slash size={12}/> /draft</button>
          <button className="ns-btn ghost tiny">@source</button>
          <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6 }}>
            <span className="tag" style={{ fontSize:10.5 }}>thorough <Icons.chevDown size={10}/></span>
            <span className="mono" style={{ fontSize:10.5, color:"var(--muted)" }}>⌘↩</span>
            <button className="ns-btn tiny"><Icons.send size={12}/> Send</button>
          </div>
        </div>
      </div>
    </div>
  </div>
);

// ─────────── Graph pane ───────────
// SVG graph with multiple modes; modes change node grouping + layout.
const GraphSVG = ({ mode = "citations", highlight = ["m2","m1","m4","m6"] }) => {
  // Hand-laid positions per mode for design-quality output.
  const layouts = {
    citations: [
      { id:"m2", x:240, y:130, label:"Olsson '22",          year:2022, kind:"pdf", deg:"primary"  },
      { id:"m1", x:120, y:230, label:"Toy models",          year:2023, kind:"pdf"    },
      { id:"m4", x:360, y:230, label:"Wang '23",            year:2023, kind:"pdf"    },
      { id:"m3", x:60,  y:330, label:"Math framework",      year:2021, kind:"pdf"    },
      { id:"m6", x:240, y:330, label:"Cowan '17",           year:2017, kind:"pdf"    },
      { id:"m5", x:420, y:330, label:"Baddeley '12",        year:2012, kind:"pdf"    },
      { id:"m7", x:170, y:420, label:"capacity-vs-attn",    year:2024, kind:"note"   },
      { id:"m8", x:330, y:420, label:"Working memory bench",year:2024, kind:"doc", draft:true},
    ],
    unified: [
      { id:"m2", x:140, y:160, label:"Olsson '22"  }, { id:"m1", x:300, y:120, label:"Toy models" },
      { id:"m4", x:440, y:180, label:"Wang '23"     }, { id:"m3", x:100, y:280, label:"Math fw" },
      { id:"m6", x:240, y:300, label:"Cowan '17"    }, { id:"m5", x:380, y:320, label:"Baddeley '12" },
      { id:"m7", x:160, y:400, label:"note · capacity" }, { id:"m8", x:340, y:420, label:"benchmarks" },
      { id:"q1", x:240, y:50,  label:"\"induction heads emerge\"", kind:"q" },
    ],
    concepts: [
      { id:"c1", x:140, y:130, label:"INDUCTION HEADS", kind:"concept" },
      { id:"c2", x:340, y:130, label:"WORKING MEMORY",  kind:"concept" },
      { id:"c3", x:240, y:280, label:"CIRCUITS",        kind:"concept" },
      { id:"c4", x:120, y:400, label:"TRAINING DYNAMICS", kind:"concept" },
      { id:"c5", x:380, y:400, label:"BENCHMARKS",      kind:"concept" },
    ],
    trail: [
      { id:"q1", x:80,  y:230, label:"USER · induction heads emerge", kind:"q" },
      { id:"r1", x:230, y:130, label:"step 1 · search", kind:"step" },
      { id:"r2", x:230, y:330, label:"step 2 · summarize", kind:"step" },
      { id:"m2", x:380, y:130, label:"Olsson §3" },
      { id:"m1", x:380, y:230, label:"Toy models" },
      { id:"m4", x:380, y:330, label:"Wang '23 fig.4" },
      { id:"a1", x:520, y:230, label:"ANSWER", kind:"answer" },
    ],
  };
  const edges = {
    citations: [["m2","m1"],["m2","m4"],["m2","m3"],["m1","m6"],["m4","m5"],["m6","m7"],["m4","m8"],["m2","m8"]],
    unified:   [["q1","m2"],["q1","m1"],["m2","m1"],["m2","m4"],["m6","m7"],["m4","m8"]],
    concepts:  [["c1","c3"],["c2","c3"],["c1","c4"],["c3","c5"],["c2","c5"]],
    trail:     [["q1","r1"],["r1","m2"],["r1","m1"],["r1","m4"],["m2","r2"],["m1","r2"],["m4","r2"],["r2","a1"]],
  };
  const nodes = layouts[mode];
  const ix = Object.fromEntries(nodes.map(n => [n.id, n]));
  const colorFor = n => {
    if (n.kind === "concept") return ["var(--paper)","var(--indigo)"];
    if (n.kind === "q")       return ["var(--ink)","#fff"];
    if (n.kind === "answer")  return ["var(--teal)","#fff"];
    if (n.kind === "step")    return ["var(--paper-2)","var(--ink-2)"];
    if (n.kind === "note")    return ["#fff","var(--ink-2)"];
    if (n.kind === "doc")     return [n.draft ? "var(--warn)" : "var(--paper-2)", "#fff"];
    if (highlight.includes(n.id)) return ["var(--indigo-soft)","var(--indigo)"];
    return ["#fff","var(--muted)"];
  };
  const radiusFor = n => n.kind === "concept" ? 50 : n.kind === "q" || n.kind === "answer" ? 38 : n.kind === "step" ? 26 : (highlight.includes(n.id) ? 20 : 14);

  return (
    <svg viewBox="0 0 600 500" width="100%" height="100%" style={{ display:"block" }}>
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r=".7" fill="var(--ink)" opacity=".07"/>
        </pattern>
      </defs>
      <rect width="600" height="500" fill="url(#grid)"/>
      {/* edges */}
      {edges[mode].map(([a,b], i) => {
        const A = ix[a], B = ix[b];
        if (!A || !B) return null;
        const isHL = highlight.includes(a) && highlight.includes(b);
        return <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={isHL ? "var(--indigo)" : "var(--rule-2)"} strokeWidth={isHL ? 1.6 : 1} strokeDasharray={mode === "trail" ? "0" : "0"}/>;
      })}
      {/* nodes */}
      {nodes.map(n => {
        const [bg, fg] = colorFor(n);
        const r = radiusFor(n);
        const isConcept = n.kind === "concept";
        const isCircle = !isConcept;
        return (
          <g key={n.id} transform={`translate(${n.x},${n.y})`}>
            {isCircle ? (
              <>
                <circle r={r} fill={bg} stroke={highlight.includes(n.id) || n.kind === "q" || n.kind === "answer" ? "var(--ink)" : "var(--rule-2)"} strokeWidth={highlight.includes(n.id) ? 1.5 : 1}/>
                {n.kind === "q" && <text y="4" textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="JetBrains Mono" fill={fg}>?</text>}
                {n.kind === "answer" && <text y="4" textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="JetBrains Mono" fill={fg}>A</text>}
                {n.kind === "step" && <text y="4" textAnchor="middle" fontSize="9" fontWeight="600" fontFamily="JetBrains Mono" fill={fg}>·</text>}
                {!n.kind && highlight.includes(n.id) && <text y="4" textAnchor="middle" fontSize="9" fontWeight="700" fontFamily="JetBrains Mono" fill={fg}>{n.year || ""}</text>}
              </>
            ) : (
              <rect x={-r} y={-18} width={r*2} height={36} rx={8} fill={bg} stroke="var(--ink)" strokeWidth="1.4"/>
            )}
            {isConcept ? (
              <text y="5" textAnchor="middle" fontSize="11" fontWeight="600" fontFamily="JetBrains Mono" fill={fg}>{n.label}</text>
            ) : (
              <text y={r + 14} textAnchor="middle" fontSize="11" fill="var(--ink)">{n.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

const GraphPane = ({ mode = "citations", onMode = () => {} }) => (
  <div className="pane" style={{ height:"100%", background:"var(--paper)" }}>
    <div className="pane-header" style={{ flexWrap:"wrap", gap:8 }}>
      <span className="pane-title">GRAPH</span>
      {/* Mode pill */}
      <div style={{ display:"flex", padding:3, background:"var(--paper-2)", borderRadius:8, border:"1px solid var(--rule)" }}>
        {[
          ["citations","Citations"],
          ["concepts","Concepts"],
          ["trail","Reasoning"],
        ].map(([id, label]) => (
          <button key={id} onClick={() => onMode(id)}
            style={{ padding:"4px 10px", fontSize:11.5, borderRadius:6, border:"none", background: mode === id ? "var(--ink)" : "transparent", color: mode === id ? "var(--paper)" : "var(--ink-2)", cursor:"pointer", fontFamily:"inherit" }}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
        <button className="ns-btn ghost tiny"><Icons.filter size={12}/> Filter</button>
        <button className="ns-btn ghost tiny"><Icons.reset size={12}/></button>
        <button className="ns-btn ghost tiny"><Icons.arrowsOut size={12}/></button>
      </div>
    </div>
    <div style={{ position:"relative", flex:1, overflow:"hidden", background:"var(--paper-2)" }}>
      <GraphSVG mode={mode}/>
      {/* legend / mode hint */}
      <div style={{ position:"absolute", left:12, bottom:12, display:"flex", flexDirection:"column", gap:6, background:"#fff", border:"1px solid var(--rule)", borderRadius:8, padding:"8px 10px", fontSize:11, color:"var(--ink-2)", lineHeight:1.4 }}>
        <div className="mono" style={{ fontSize:10, color:"var(--muted)", letterSpacing:".08em" }}>{ {citations:"WHO CITES WHOM",unified:"SOURCES + QUERIES",concepts:"EXTRACTED CONCEPTS",trail:"AGENT REASONING TRAIL"}[mode] }</div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}><span style={{ width:8, height:8, borderRadius:4, background:"var(--indigo)" }}/> referenced by latest answer</div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}><span style={{ width:8, height:8, borderRadius:4, background:"var(--warn)" }}/> draft / note</div>
      </div>
      {/* mini-map */}
      <div style={{ position:"absolute", right:12, bottom:12, width:120, height:80, background:"#fff", border:"1px solid var(--rule)", borderRadius:8, padding:6 }}>
        <div className="mono" style={{ fontSize:9, color:"var(--muted)", letterSpacing:".08em", marginBottom:4 }}>MAP</div>
        <div style={{ position:"relative", width:"100%", height:55, background:"var(--paper-2)", borderRadius:4 }}>
          <div style={{ position:"absolute", left:18, top:8, width:38, height:30, border:"1px solid var(--indigo)", borderRadius:3 }}/>
        </div>
      </div>
      {/* zoom controls */}
      <div style={{ position:"absolute", right:12, top:12, display:"flex", flexDirection:"column", background:"#fff", border:"1px solid var(--rule)", borderRadius:8, overflow:"hidden" }}>
        <button className="ns-btn ghost tiny" style={{ borderRadius:0, borderColor:"transparent", padding:6 }}><Icons.plus size={12}/></button>
        <div style={{ height:1, background:"var(--rule)" }}/>
        <button className="ns-btn ghost tiny" style={{ borderRadius:0, borderColor:"transparent", padding:6 }}>−</button>
      </div>
    </div>
  </div>
);

// ─────────── Reader pane ───────────
const ReaderPane = ({ source = { name:"Olsson et al. '22 — Induction heads", year:2022 } }) => (
  <div className="pane" style={{ height:"100%" }}>
    <div className="pane-header">
      <Icons.pdf size={14}/>
      <div>
        <div style={{ fontSize:13, fontWeight:500 }}>{source.name}</div>
        <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".04em" }}>{source.year} · §3 SCROLLED</div>
      </div>
      <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
        <button className="ns-btn ghost tiny">Highlight</button>
        <button className="ns-btn ghost tiny">Note</button>
        <button className="ns-btn ghost tiny"><Icons.kebab size={12}/></button>
      </div>
    </div>
    <div className="pane-body" style={{ padding:"22px 28px", background:"#fff" }}>
      <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>SECTION 3 · TRAINING DYNAMICS</div>
      <h2 className="serif" style={{ fontSize:22, lineHeight:1.2, margin:"0 0 12px", fontWeight:500 }}>Phase changes around induction heads.</h2>
      <p className="serif" style={{ fontSize:14, lineHeight:1.65, color:"var(--ink-2)", margin:"0 0 12px" }}>
        We observe a <mark style={{ background:"color-mix(in oklch, var(--indigo) 18%, transparent)", padding:"0 3px", borderRadius:3 }}>narrow window during training</mark> in which the loss drops sharply and the
        attention heads in the second layer suddenly begin to perform an
        operation we call <em>induction</em>: copying tokens from earlier
        positions whose surrounding context resembles the current one.
      </p>
      <p className="serif" style={{ fontSize:14, lineHeight:1.65, color:"var(--ink-2)", margin:"0 0 12px" }}>
        The phenomenon is robust across model widths from 70M to 13B
        parameters. <span style={{ background:"color-mix(in oklch, var(--teal) 22%, transparent)", padding:"0 3px", borderRadius:3 }}>The transition is more reliable in tokens-seen than in steps</span>, suggesting it depends on dataset coverage.
      </p>
      <div style={{ padding:"12px 14px", background:"var(--paper-2)", border:"1px dashed var(--rule-2)", borderRadius:8, fontSize:13, color:"var(--ink-2)", margin:"14px 0" }}>
        <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".08em", marginBottom:4 }}>YOUR NOTE · APR 24</div>
        Hypothesis: this is what's missing from the working-memory benchmark — short-context induction is too easy and saturates.
      </div>
      <div style={{ display:"flex", gap:8, marginTop:18 }}>
        <button className="ns-btn ghost tiny">Ask about this passage →</button>
        <button className="ns-btn ghost tiny">Pin to graph</button>
      </div>
    </div>
  </div>
);

// ─────────── Drafter pane ───────────
const DrafterPane = () => (
  <div className="pane" style={{ height:"100%" }}>
    <div className="pane-header">
      <Icons.doc size={14}/>
      <div>
        <div style={{ fontSize:13, fontWeight:500 }}>Working memory benchmarks for LMs.md</div>
        <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".04em" }}>DRAFT · 12 KB · LAST EDIT 14:02</div>
      </div>
      <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
        <button className="ns-btn ghost tiny">Outline</button>
        <button className="ns-btn ghost tiny">Cite ↩</button>
        <button className="ns-btn tiny">Publish</button>
      </div>
    </div>
    <div className="pane-body" style={{ padding:"22px 32px", background:"#fff", maxWidth:760, margin:"0 auto", width:"100%" }}>
      <h1 className="serif" style={{ fontSize:30, fontWeight:500, letterSpacing:"-0.02em", margin:"0 0 6px" }}>Working memory benchmarks for language models.</h1>
      <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".08em", marginBottom:18 }}>JIN PARK · APRIL DRAFT · v0.4</div>
      <h3 className="serif" style={{ fontSize:18, fontWeight:500, margin:"18px 0 6px" }}>Why most current evals miss the point.</h3>
      <p className="serif" style={{ fontSize:14.5, lineHeight:1.65, color:"var(--ink-2)", margin:"0 0 12px" }}>
        If induction heads form during a narrow training window <span className="cite">1 2022</span>,
        the standard "long context" benchmark conflates two distinct
        capabilities — surface-level retrieval (which is solved as soon as
        induction heads appear) and the harder problem of holding multiple
        bound items in working memory <span className="cite">4 2017</span>.
      </p>
      <p className="serif" style={{ fontSize:14.5, lineHeight:1.65, color:"var(--ink-2)", margin:"0 0 12px" }}>
        Below I propose a four-task evaluation that disambiguates the two,
        following Cowan's chunk capacity framework but adapted to the
        token-level vocabulary the LM operates over.
      </p>
      {/* AI inline assist */}
      <div style={{ borderLeft:"3px solid var(--indigo)", padding:"10px 12px", background:"var(--indigo-soft)", borderRadius:"0 8px 8px 0", display:"flex", flexDirection:"column", gap:6, fontSize:13 }}>
        <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--indigo)" }}>NOTESCI · CONTINUE WRITING</div>
        <div style={{ color:"var(--ink-2)" }}>
          The task definitions can pull directly from the n-back paradigm — want me to draft §2 from your saved Baddeley + Cowan notes?
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <button className="ns-btn tiny">Draft §2 →</button>
          <button className="ns-btn ghost tiny">Dismiss</button>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, { TopBar, SidePanel, ChatPane, GraphPane, GraphSVG, ReaderPane, DrafterPane });
