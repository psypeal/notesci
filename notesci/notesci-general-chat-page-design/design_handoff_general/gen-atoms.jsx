// gen-atoms.jsx — the two key building blocks (QuoteBlock + ChatBox)
// pulled in from earlier chat-box handoff so this page is self-contained.

const { Icons } = window;

// ── Human-prompt block (V2 · Quote · the locked-in design) ──
const QuoteBlock = ({ text, width = 680 }) => (
  <div style={{ width, position:"relative", padding:"24px 4px 24px 36px" }}>
    <span style={{ position:"absolute", left:16, top:0, bottom:0, width:1,
      background:"linear-gradient(180deg, var(--indigo) 0%, var(--indigo) 14%, var(--rule-2) 14%, var(--rule-2) 100%)" }}/>
    <div className="serif" style={{ fontSize:20, lineHeight:1.45, color:"var(--ink)",
      fontStyle:"italic", fontWeight:500, letterSpacing:"-0.005em", textWrap:"pretty" }}>
      {text}
    </div>
  </div>
);

// ── Assistant message block — paragraphs in serif, no card ──
const AssistantBlock = ({ text, model = "thorough", web = false }) => (
  <div style={{ width:680, padding:"4px 4px 4px 0" }}>
    {text.split("\n\n").map((p, i) => (
      <p key={i} className="serif" style={{ fontSize:15.5, lineHeight:1.65, color:"var(--ink-2)", margin: i === 0 ? "0 0 12px" : "0 0 12px" }}>{p}</p>
    ))}
    <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:6 }}>
      {web && (
        <span className="mono" style={{ fontSize:10, color:"var(--teal)", letterSpacing:".08em", display:"inline-flex", alignItems:"center", gap:5 }}>
          <Icons.search size={11}/> GROUNDED · WEB SEARCH · 6 RESULTS
        </span>
      )}
      <span className="mono" style={{ fontSize:10, color:"var(--muted-2)", letterSpacing:".06em" }}>{model}</span>
      <span style={{ flex:1 }}/>
      <button className="ns-btn ghost" style={{ height:22, padding:"0 8px", fontSize:11, borderColor:"transparent", color:"var(--muted)" }}>Copy</button>
      <button className="ns-btn ghost" style={{ height:22, padding:"0 8px", fontSize:11, borderColor:"transparent", color:"var(--muted)" }}>↻ Retry</button>
    </div>
  </div>
);

// ── Chat composer — same component as the workspace, slightly leaner ──
const ChatBox = ({
  text = "",
  placeholder = "Ask anything · /commands · attach files · search the web",
  model = "Thorough",
  modelDot = "var(--teal)",
  webOn = false,
  attachments = [],
  inputAccent = false,
  rows = 2,
  width = 720,
}) => (
  <div style={{ width, display:"flex", flexDirection:"column" }}>
    <div style={{
      background:"#fff",
      border:`1px solid ${inputAccent ? "var(--indigo)" : "var(--rule)"}`,
      borderRadius:14,
      boxShadow: inputAccent
        ? "0 0 0 4px color-mix(in oklch, var(--indigo) 14%, transparent), 0 12px 28px -10px rgba(14,17,22,.12), 0 2px 6px -2px rgba(14,17,22,.06)"
        : "0 1px 0 rgba(255,255,255,.8) inset, 0 12px 28px -12px rgba(14,17,22,.10), 0 2px 6px -2px rgba(14,17,22,.06)",
      overflow:"hidden",
    }}>
      {attachments.length > 0 && (
        <div style={{ display:"flex", gap:8, padding:"10px 14px 0", flexWrap:"wrap" }}>
          {attachments.map((a, i) => (
            <span key={i} style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"6px 10px", borderRadius:8, background:"var(--paper)", border:"1px solid var(--rule)", fontSize:11.5 }}>
              {a.kind === "pdf" ? <Icons.pdf size={12}/> : a.kind === "web" ? <Icons.search size={12}/> : <Icons.doc size={12}/>}
              <span>{a.name}</span>
              {a.size && <span className="mono" style={{ color:"var(--muted)", fontSize:10 }}>{a.size}</span>}
              <span style={{ marginLeft:2, color:"var(--muted)", cursor:"pointer" }}>×</span>
            </span>
          ))}
        </div>
      )}
      <textarea
        rows={rows}
        placeholder={placeholder}
        defaultValue={text}
        style={{ resize:"none", width:"100%", border:"none", outline:"none",
          padding:"14px 16px 8px", font:"inherit", fontSize:14.5, lineHeight:1.55,
          color:"var(--ink)", background:"transparent", display:"block" }}/>
      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 10px 10px", borderTop:"1px solid var(--rule)" }}>
        <button className="ns-btn ghost" style={{ height:30, padding:"0 9px", borderColor:"transparent", color:"var(--muted)" }} title="Attach files">
          <Icons.attach size={14}/>
        </button>
        <button className="ns-btn ghost" style={{ height:30, padding:"0 10px", fontSize:12.5, borderColor: webOn ? "var(--teal)" : "transparent", background: webOn ? "var(--teal-soft)" : "transparent", color: webOn ? "var(--teal)" : "var(--ink-2)", gap:6 }}>
          <Icons.search size={12}/> Web {webOn ? "on" : "search"}
        </button>
        <button className="ns-btn ghost" style={{ height:30, padding:"0 10px", fontSize:12.5, borderColor:"transparent", color:"var(--ink-2)", gap:6 }}>
          <Icons.slash size={12}/> Commands
        </button>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10 }}>
          <button className="ns-btn ghost" style={{ height:30, padding:"0 10px", fontSize:11.5, gap:6, borderColor:"var(--rule)", color:"var(--ink-2)" }}>
            <span style={{ width:6, height:6, borderRadius:3, background:modelDot }}/>
            {model}
            <Icons.chevDown size={11}/>
          </button>
          <span className="mono" style={{ fontSize:10.5, color:"var(--muted-2)", letterSpacing:".04em" }}>⌘↩</span>
          <button className="ns-btn" disabled={text.length === 0 && attachments.length === 0}
            style={{ height:30, padding:"0 14px", fontSize:12.5, gap:6, background:"var(--indigo)", borderColor:"var(--indigo)" }}>
            <Icons.send size={12}/> Ask
          </button>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, { QuoteBlock, AssistantBlock, ChatBox });
