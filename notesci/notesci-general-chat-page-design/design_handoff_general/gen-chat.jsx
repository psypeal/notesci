// gen-chat.jsx — active conversation surface.

const { Icons } = window;
const { GEN_MESSAGES } = window;
const { QuoteBlock, AssistantBlock, ChatBox } = window;
const { GenTopBar, GenRail, GenRailCollapsed, GenFrame } = window;

// Header strip above the conversation — just the session title + actions
const ConversationHeader = ({ title = "Compare PEFT methods · which for small VRAM?", showPromoteBanner = false }) => (
  <div style={{ display:"flex", alignItems:"center", padding:"14px 28px", borderBottom:"1px solid var(--rule)", gap:12, background:"#fff", position:"sticky", top:0, zIndex:2 }}>
    <span style={{ width:6, height:6, borderRadius:3, background:"var(--indigo)" }}/>
    <div style={{ fontSize:13.5, fontWeight:500, color:"var(--ink)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{title}</div>
    <span className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em" }}>2h · 14 msgs · general</span>
    <button className="ns-btn ghost" style={{ height:26, padding:"0 8px", fontSize:11, borderColor:"transparent", color:"var(--muted)" }}><Icons.pin size={12}/></button>
    <button className="ns-btn ghost" style={{ height:26, padding:"0 8px", fontSize:11, borderColor:"transparent", color:"var(--muted)" }}><Icons.share size={12}/></button>
    <button className="ns-btn ghost" style={{ height:26, padding:"0 8px", fontSize:11, borderColor:"transparent", color:"var(--muted)" }}><Icons.kebab size={12}/></button>
  </div>
);

// A subtle banner that appears after ~3 messages: "this is looking like a project"
const PromoteBanner = ({ onPromote }) => (
  <div style={{
    width:680, padding:"14px 20px",
    background:"linear-gradient(180deg, var(--indigo-soft) 0%, color-mix(in oklch, var(--indigo-soft) 60%, white) 100%)",
    border:"1px solid color-mix(in oklch, var(--indigo) 25%, transparent)",
    borderRadius:12,
    display:"flex", alignItems:"center", gap:14,
  }}>
    <div style={{ flexShrink:0, width:32, height:32, borderRadius:8, background:"#fff", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--indigo)" }}>
      <Icons.layers size={16}/>
    </div>
    <div style={{ flex:1 }}>
      <div style={{ fontSize:13, fontWeight:500, color:"var(--ink)" }}>This is starting to look like a project.</div>
      <div style={{ fontSize:12, color:"var(--ink-2)", marginTop:1 }}>Save the thread and you'll get a citation graph, drafts, and persistent scope.</div>
    </div>
    <button onClick={onPromote} className="ns-btn" style={{ height:30, padding:"0 14px", fontSize:12, gap:6, background:"var(--indigo)", borderColor:"var(--indigo)" }}>
      Save as project →
    </button>
    <button className="ns-btn ghost" style={{ height:30, padding:"0 8px", fontSize:11, borderColor:"transparent", color:"var(--muted)" }} title="Dismiss">×</button>
  </div>
);

const GenChat = ({ showPromote = false, attachments = [], webOn = false, composerText = "", sidebar = "open" }) => (
  <GenFrame>
    <GenTopBar promoteHint={true}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
      {sidebar === "collapsed" ? <GenRailCollapsed/> : <GenRail/>}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        <ConversationHeader/>
        {/* messages */}
        <div style={{ flex:1, overflow:"auto", padding:"28px 0 24px", display:"flex", flexDirection:"column", alignItems:"center", gap:28 }}>
          {GEN_MESSAGES.map((m, i) => (
            m.who === "user"
              ? <QuoteBlock key={i} text={m.text}/>
              : <AssistantBlock key={i} text={m.text} model={m.model} web={m.web}/>
          ))}
          {showPromote && <PromoteBanner/>}
        </div>
        {/* composer */}
        <div style={{ display:"flex", justifyContent:"center", padding:"14px 24px 22px",
          background:"linear-gradient(180deg, transparent 0%, #fff 40%)" }}>
          <ChatBox
            text={composerText}
            attachments={attachments}
            webOn={webOn}
            rows={2}
            placeholder="Continue the conversation…"
          />
        </div>
      </div>
    </div>
  </GenFrame>
);

Object.assign(window, { GenChat, ConversationHeader, PromoteBanner });
