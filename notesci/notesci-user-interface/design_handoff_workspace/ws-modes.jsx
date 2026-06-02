// ws-modes.jsx — five layout presets that compose the panes.
const { TopBar, SidePanel, ChatPane, GraphPane, ReaderPane, DrafterPane } = window;

const Frame = ({ children, w = 1440, h = 900, label }) => (
  <div style={{ width:w, height:h, background:"var(--paper-3)", display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
    {children}
    {label && (
      <div className="mono" style={{ position:"absolute", left:14, bottom:8, fontSize:10, color:"var(--muted)", letterSpacing:".1em" }}>{label}</div>
    )}
  </div>
);

const ModeDefault = ({ graphMode = "citations", setGraphMode = () => {}, layout = "default", onLayout = () => {} }) => (
  <Frame>
    <TopBar layout={layout} onLayout={onLayout}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
      <SidePanel/>
      <div className="splitter-v"/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", padding:12, gap:6 }}>
        <div style={{ flex:"1 1 60%", minHeight:0 }}><ChatPane/></div>
        <div className="splitter-h"/>
        <div style={{ flex:"1 1 40%", minHeight:0 }}><GraphPane mode={graphMode} onMode={setGraphMode}/></div>
      </div>
    </div>
  </Frame>
);

const ModeReading = ({ graphMode = "citations", layout = "reading", onLayout = () => {} }) => (
  <Frame>
    <TopBar layout={layout} onLayout={onLayout}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
      <SidePanel width={240}/>
      <div className="splitter-v"/>
      <div style={{ flex:"1 1 60%", padding:"12px 6px 12px 12px" }}><ReaderPane/></div>
      <div className="splitter-v"/>
      <div style={{ flex:"1 1 40%", padding:"12px 12px 12px 6px" }}><GraphPane mode={graphMode}/></div>
    </div>
  </Frame>
);

const ModeDrafting = ({ layout = "drafting", onLayout = () => {} }) => (
  <Frame>
    <TopBar layout={layout} onLayout={onLayout}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
      <SidePanel width={240}/>
      <div className="splitter-v"/>
      <div style={{ flex:"1 1 50%", padding:"12px 6px 12px 12px" }}><DrafterPane/></div>
      <div className="splitter-v"/>
      <div style={{ flex:"1 1 50%", padding:"12px 12px 12px 6px" }}><ChatPane scopeChips={false}/></div>
    </div>
  </Frame>
);

Object.assign(window, { Frame, ModeDefault, ModeReading, ModeDrafting });
