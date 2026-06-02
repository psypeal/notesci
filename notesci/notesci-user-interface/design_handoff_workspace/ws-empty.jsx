// ws-empty.jsx — empty / first-run states
const { Icons, Frame, SidePanel } = window;
const TopBar = window.TopBar;

const EmptyCard = ({ kind, title, desc, primary, secondary, illus }) => (
  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", padding:"60px 40px", maxWidth:520, margin:"auto", color:"var(--ink-2)" }}>
    <div style={{ marginBottom:18, color:"var(--muted)" }}>{illus}</div>
    <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:8 }}>{kind}</div>
    <div className="serif" style={{ fontSize:26, lineHeight:1.2, fontWeight:500, color:"var(--ink)", marginBottom:10 }}>{title}</div>
    <div style={{ fontSize:14, lineHeight:1.55, marginBottom:22 }}>{desc}</div>
    <div style={{ display:"flex", gap:8 }}>
      {primary  && <button className="ns-btn">{primary}</button>}
      {secondary && <button className="ns-btn ghost">{secondary}</button>}
    </div>
  </div>
);

const EmptyMaterials = () => (
  <Frame>
    <TopBar/>
    <div style={{ flex:1, display:"flex" }}>
      <SidePanel/>
      <div className="splitter-v"/>
      <div style={{ flex:1, display:"flex" }}>
        <EmptyCard kind="THIS PROJECT IS EMPTY"
          title="Drop a few PDFs to start a session."
          desc="notesci needs at least one source to ground its answers. Anything goes — papers, notes, web articles, recorded talks."
          primary="+ Upload materials" secondary="Connect Zotero"
          illus={
            <svg width="120" height="80" viewBox="0 0 120 80" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="8"  y="20" width="34" height="46" rx="3"/>
              <rect x="44" y="14" width="34" height="52" rx="3"/>
              <rect x="80" y="22" width="34" height="44" rx="3"/>
              <path d="M52 30h18M52 38h14M52 46h18" stroke="var(--rule-2)"/>
            </svg>
          }/>
      </div>
    </div>
  </Frame>
);

const EmptySession = () => (
  <Frame>
    <TopBar/>
    <div style={{ flex:1, display:"flex" }}>
      <SidePanel/>
      <div className="splitter-v"/>
      <div style={{ flex:1, padding:24, display:"flex", flexDirection:"column", gap:6 }}>
        <div className="pane" style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:40 }}>
          <EmptyCard kind="NEW SESSION · 23 SOURCES IN SCOPE"
            title="What are you trying to figure out?"
            desc="Ask a focused question. notesci will answer using only your project's materials, with citations linking to the exact passages."
            illus={
              <svg width="80" height="80" viewBox="0 0 80 80" fill="none" stroke="currentColor" strokeWidth="1.4">
                <circle cx="40" cy="40" r="22"/>
                <path d="M30 38c2-6 12-7 14 0c1 5-6 5-6 10M40 56v.01"/>
              </svg>
            }/>
        </div>
        <div style={{ display:"flex", gap:6, padding:"0 4px" }}>
          {["Summarize all 23 papers","Compare Olsson and Wang","Find papers I haven't read","Draft a literature review"].map(s => (
            <span key={s} className="tag" style={{ padding:"6px 10px", fontSize:11.5, cursor:"pointer", background:"#fff" }}>{s}</span>
          ))}
        </div>
      </div>
    </div>
  </Frame>
);

const EmptyProjects = () => (
  <Frame>
    <TopBar/>
    <div style={{ flex:1, display:"flex" }}>
      <EmptyCard kind="WELCOME, JIN"
        title="Start your first project."
        desc="A project is a topic you're researching. Each holds its materials, sessions, and graph — separate from the rest, so notesci stays grounded."
        primary="+ New project" secondary="Import from Notion"
        illus={
          <svg width="120" height="80" viewBox="0 0 120 80" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="30" cy="40" r="14"/><circle cx="60" cy="22" r="9"/>
            <circle cx="90" cy="40" r="14"/><circle cx="60" cy="58" r="9"/>
            <path d="m40 38 14-12M70 26l12 8M82 50 70 56M40 44l14 12" stroke="var(--rule-2)"/>
          </svg>
        }/>
    </div>
  </Frame>
);

Object.assign(window, { EmptyMaterials, EmptySession, EmptyProjects });
