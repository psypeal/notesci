// gen-landing.jsx — empty / first-time landing state for general chat.

const { Mark } = window;
const { Icons } = window;
const { ME, STARTER_CHIPS, GEN_SESSIONS } = window;
const { ChatBox } = window;
const { GenTopBar, GenRail, GenFrame } = window;

const GenLanding = () => {
  const recent = GEN_SESSIONS.filter(s => !s.archived).slice(0, 4);
  return (
    <GenFrame>
      <GenTopBar/>
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        <GenRail/>
        <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 24px", overflow:"auto" }}>
          {/* Editorial title */}
          <div style={{ width:720, marginBottom:24 }}>
            <div className="mono" style={{ fontSize:11, letterSpacing:".12em", color:"var(--muted)", marginBottom:10 }}>GENERAL CHAT · {ME.name.toUpperCase()}</div>
            <h1 className="serif" style={{ fontSize:42, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>
              What are you looking into <em style={{ color:"var(--indigo)" }}>today</em>?
            </h1>
            <p style={{ fontSize:14, color:"var(--muted)", margin:"12px 0 0", lineHeight:1.55, maxWidth:560 }}>
              Ask anything. Drop a PDF for a one-off summary. Search the web for fresh sources. When a thread starts feeling like a real project, you can save it as one — and get the graph, library, and drafting workspace.
            </p>
          </div>

          {/* Composer */}
          <ChatBox width={720} inputAccent={false}/>

          {/* Starter chips */}
          <div style={{ width:720, marginTop:18, display:"flex", gap:8, flexWrap:"wrap" }}>
            {STARTER_CHIPS.map(c => {
              const I = Icons[c.icon] || Icons.sparkles;
              return (
                <button key={c.label} className="ns-btn ghost" style={{ height:30, padding:"0 12px", fontSize:12, gap:7, color:"var(--ink-2)", borderColor:"var(--rule)" }}>
                  <I size={12}/> {c.label}
                </button>
              );
            })}
          </div>

          {/* Recent + project hint, two columns */}
          <div style={{ width:720, marginTop:48, display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:28 }}>
            <div>
              <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:10 }}>PICK UP WHERE YOU LEFT OFF</div>
              <div style={{ display:"flex", flexDirection:"column" }}>
                {recent.map((s, i) => (
                  <div key={s.id} style={{
                    display:"flex", alignItems:"center", gap:10,
                    padding:"10px 0", borderBottom: i < recent.length - 1 ? "1px solid var(--rule)" : "none",
                  }}>
                    <span style={{ width:5, height:5, borderRadius:3, background: s.pinned ? "var(--indigo)" : "var(--rule-2)" }}/>
                    <span style={{ flex:1, fontSize:13, color:"var(--ink-2)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.title}</span>
                    <span className="mono" style={{ fontSize:10.5, color:"var(--muted)" }}>{s.ago}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding:"18px 20px", background:"var(--paper-2)", border:"1px solid var(--rule)", borderRadius:12 }}>
              <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:8 }}>WHEN TO USE A PROJECT</div>
              <div className="serif" style={{ fontSize:16, lineHeight:1.35, color:"var(--ink)", fontWeight:500, letterSpacing:"-0.01em", marginBottom:8 }}>
                Projects ground answers in your own corpus.
              </div>
              <div style={{ fontSize:12.5, color:"var(--ink-2)", lineHeight:1.5 }}>
                Once a thread leans on more than two sources, a project gives you a citation graph, a drafts surface, and persistent scope.
              </div>
              <button className="ns-btn ghost" style={{ marginTop:12, height:28, padding:"0 12px", fontSize:12, gap:6 }}>
                <Icons.folder size={12}/> Browse projects
              </button>
            </div>
          </div>
        </div>
      </div>
    </GenFrame>
  );
};

window.GenLanding = GenLanding;
