// gen-shell.jsx — top bar + left sessions rail.

const { Mark } = window;
const { Icons } = window;
const { ME, GEN_SESSIONS } = window;

// ── Top bar — mirrors the project workspace top bar layout ──
// Same skeleton (mark · divider · context · centered search · right cluster)
// so users feel at home moving between general and a project. The
// "project switcher" slot is replaced by a non-clickable "General"
// indicator, and the "Save as project" button takes the place of "Share".
const GenTopBar = ({ promoteHint = false }) => {
  const H = 28;
  return (
    <div style={{ height:52, background:"#fff", borderBottom:"1px solid var(--rule)",
      display:"flex", alignItems:"center", padding:"0 14px", gap:10, fontSize:13, color:"var(--ink)" }}>
      <Mark size={32} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ width:1, height:20, background:"var(--rule)", margin:"0 4px" }}/>

      {/* Context slot — where project name lives in workspace; here a "General" pill */}
      <div className="row" style={{ height:H, padding:"0 10px", borderRadius:7, fontSize:12, lineHeight:1, gap:8, display:"inline-flex", alignItems:"center", color:"var(--ink-2)" }}>
        <span style={{ width:6, height:6, borderRadius:3, background:"var(--teal)" }}/>
        <span className="mono" style={{ letterSpacing:".08em", color:"var(--muted)" }}>GENERAL</span>
      </div>

      {/* Centered search — same as workspace */}
      <div style={{ flex:1, display:"flex", justifyContent:"center" }}>
        <div style={{ width:520, height:H, display:"flex", alignItems:"center", gap:8, padding:"0 10px", border:"1px solid var(--rule)", borderRadius:8, background:"var(--paper-2)", color:"var(--muted)" }}>
          <Icons.search size={14}/>
          <span style={{ fontSize:12.5 }}>Search your chats, or run a command…</span>
          <span style={{ marginLeft:"auto", fontSize:11 }} className="mono">⌘K</span>
        </div>
      </div>

      {/* Right cluster — mirrors workspace order (invite-like → ghost → primary → avatar) */}
      <button className="ns-btn ghost" style={{ height:H, padding:"0 10px", fontSize:12, gap:6,
        borderColor: promoteHint ? "var(--indigo)" : "var(--rule-2)",
        background: promoteHint ? "var(--indigo-soft)" : "transparent",
        color: promoteHint ? "var(--indigo)" : "var(--ink-2)" }}>
        <Icons.layers size={12}/> Save as project
      </button>
      <button className="ns-btn ghost" style={{ height:H, padding:"0 10px", fontSize:12, gap:6 }}>
        <Icons.share size={12}/> Share
      </button>
      <button className="ns-btn" style={{ height:H, padding:"0 12px", fontSize:12, gap:6 }}>
        <Icons.plus size={12}/> New chat
      </button>
      <div style={{ width:H, height:H, borderRadius:H/2, background:"var(--indigo)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:600, marginLeft:2 }}>{ME.avatar}</div>
    </div>
  );
};

// ── Session row ──
const SessionRow = ({ s }) => (
  <div style={{
    display:"flex", alignItems:"flex-start", gap:8,
    padding:"8px 10px", borderRadius:7,
    background: s.active ? "var(--paper-2)" : "transparent",
    opacity: s.archived ? .55 : 1,
    cursor:"pointer",
  }}>
    <span style={{ width:6, height:6, borderRadius:3, marginTop:6,
      background: s.active ? "var(--indigo)" : (s.archived ? "var(--muted-2)" : "var(--rule-2)") }}/>
    <div style={{ flex:1, minWidth:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div style={{ fontSize:12.5, lineHeight:1.3,
          color: s.active ? "var(--ink)" : "var(--ink-2)",
          fontWeight: s.active ? 500 : 400,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {s.title}
        </div>
        {s.pinned && <Icons.pin size={10}/>}
        {s.starred && <span style={{ color:"var(--warn)" }}><Icons.starFill size={10}/></span>}
      </div>
      <div className="mono" style={{ fontSize:10, color:"var(--muted)", marginTop:2, display:"flex", gap:6 }}>
        <span>{s.ago}</span><span>·</span><span>{s.n} msgs</span>
      </div>
    </div>
  </div>
);

// ── Left rail ──
const GenRail = ({ width = 252, onCollapse }) => {
  const pinned   = GEN_SESSIONS.filter(s => s.pinned && !s.archived);
  const recent   = GEN_SESSIONS.filter(s => !s.pinned && !s.archived);
  const archived = GEN_SESSIONS.filter(s => s.archived);
  return (
    <div style={{ width, background:"var(--paper)", borderRight:"1px solid var(--rule)",
      height:"100%", overflowY:"auto", display:"flex", flexDirection:"column" }}>
      {/* Header row: section label + collapse */}
      <div style={{ padding:"12px 12px 8px", display:"flex", alignItems:"center", gap:8 }}>
        <span className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", flex:1 }}>YOUR CHATS</span>
        <button onClick={onCollapse} className="ns-btn ghost" title="Hide sidebar"
          style={{ height:24, padding:"0 6px", borderColor:"transparent", color:"var(--muted)" }}>
          <Icons.panelFilled size={14}/>
        </button>
      </div>
      {/* Search */}
      <div style={{ padding:"0 12px 10px" }}>
        <div style={{ position:"relative" }}>
          <input
            placeholder="Search your chats…"
            style={{ width:"100%", padding:"7px 10px 7px 28px", border:"1px solid var(--rule)",
              borderRadius:7, background:"var(--paper-2)", font:"inherit", fontSize:12, outline:"none" }}/>
          <span style={{ position:"absolute", left:9, top:8, color:"var(--muted)" }}><Icons.search size={12}/></span>
        </div>
      </div>

      {/* PINNED */}
      {pinned.length > 0 && (
        <>
          <div className="mono" style={{ padding:"6px 16px 4px", fontSize:10, letterSpacing:".1em", color:"var(--muted)" }}>PINNED</div>
          <div style={{ padding:"0 6px 4px" }}>{pinned.map(s => <SessionRow key={s.id} s={s}/>)}</div>
        </>
      )}

      {/* RECENT */}
      <div className="mono" style={{ padding:"10px 16px 4px", fontSize:10, letterSpacing:".1em", color:"var(--muted)" }}>RECENT</div>
      <div style={{ padding:"0 6px 4px", flex:"0 1 auto" }}>{recent.map(s => <SessionRow key={s.id} s={s}/>)}</div>

      {/* ARCHIVED */}
      {archived.length > 0 && (
        <>
          <div className="mono" style={{ padding:"10px 16px 4px", fontSize:10, letterSpacing:".1em", color:"var(--muted)" }}>ARCHIVED</div>
          <div style={{ padding:"0 6px 4px" }}>{archived.map(s => <SessionRow key={s.id} s={s}/>)}</div>
        </>
      )}

      {/* Footer: open a project */}
      <div style={{ marginTop:"auto", padding:14, borderTop:"1px solid var(--rule)" }}>
        <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>RESEARCH MODE</div>
        <button className="ns-btn ghost" style={{ width:"100%", height:30, padding:"0 10px", fontSize:12, justifyContent:"flex-start", gap:8 }}>
          <Icons.folder size={13}/> Open a project →
        </button>
      </div>
    </div>
  );
};

// Collapsed sidebar — thin gutter with a single expand button
const GenRailCollapsed = ({ onExpand }) => (
  <div style={{ width:40, background:"var(--paper)", borderRight:"1px solid var(--rule)",
    height:"100%", display:"flex", flexDirection:"column", alignItems:"center", padding:"12px 0" }}>
    <button onClick={onExpand} className="ns-btn ghost" title="Show sidebar"
      style={{ height:28, width:28, padding:0, borderColor:"transparent", color:"var(--muted)" }}>
      <Icons.panel size={14}/>
    </button>
  </div>
);

// ── Frame ──
const GenFrame = ({ children, w = 1440, h = 900 }) => (
  <div style={{ width:w, height:h, background:"#fff", display:"flex", flexDirection:"column", overflow:"hidden" }}>
    {children}
  </div>
);

Object.assign(window, { GenTopBar, GenRail, GenRailCollapsed, GenFrame, SessionRow });
