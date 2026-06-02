// gen-promote.jsx — promote-to-project modal.

const { Icons } = window;
const { GEN_MESSAGES } = window;
const { GenTopBar, GenRail, GenFrame } = window;
const { ConversationHeader } = window;
const { QuoteBlock, AssistantBlock, ChatBox } = window;

const PromoteModal = ({ onClose, contained = true }) => {
  const overlay = {
    position: contained ? "absolute" : "fixed", inset:0,
    background:"rgba(14,17,22,.42)", zIndex:50,
    display:"flex", alignItems:"center", justifyContent:"center", padding:24,
  };
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()}
        style={{ width:540, background:"var(--paper)", border:"1px solid var(--rule)",
          borderRadius:14, padding:28, position:"relative",
          boxShadow:"0 24px 64px -16px rgba(14,17,22,.32)", display:"flex", flexDirection:"column", gap:18 }}>
        {/* close */}
        <button onClick={onClose} className="ns-btn ghost"
          style={{ position:"absolute", top:14, right:14, height:24, padding:"0 8px", fontSize:12, color:"var(--muted)", borderColor:"transparent" }}>✕</button>

        {/* header */}
        <div>
          <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:8 }}>SAVE AS PROJECT</div>
          <h2 className="serif" style={{ fontSize:28, lineHeight:1.1, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>
            Turn this chat into a <em style={{ color:"var(--indigo)", fontStyle:"normal" }}>research project</em>.
          </h2>
          <p style={{ fontSize:13.5, color:"#3a342c", lineHeight:1.55, margin:"10px 0 0" }}>
            Projects ground answers in your own corpus. You'll get a citation graph, drafts surface, and persistent scope.
          </p>
        </div>

        {/* Name */}
        <label style={{ display:"flex", flexDirection:"column", gap:6 }}>
          <span className="mono" style={{ fontSize:10.5, letterSpacing:".1em", color:"var(--muted)", textTransform:"uppercase" }}>Project name</span>
          <input
            defaultValue="PEFT methods · small-VRAM survey"
            style={{ width:"100%", padding:"10px 12px", border:"1px solid var(--rule-2)", borderRadius:8, font:"inherit", fontSize:13.5, background:"#fff", outline:"none" }}/>
          <span style={{ fontSize:11.5, color:"var(--muted)" }}>Suggested from the first message · rename anytime.</span>
        </label>

        {/* Carry-over choice */}
        <div>
          <div className="mono" style={{ fontSize:10.5, letterSpacing:".1em", color:"var(--muted)", marginBottom:8, textTransform:"uppercase" }}>What to carry over</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {[
              { id:"all",    title:"Bring everything", desc:"All messages and any attached files move into the project. This chat ends.", selected:true },
              { id:"copy",   title:"Bring as starting point", desc:"Copy the messages into the project. Keep this chat in general history too.", selected:false },
              { id:"fresh",  title:"Start fresh",      desc:"Create an empty project. Leave this chat as-is in general.", selected:false },
            ].map(opt => (
              <label key={opt.id} style={{
                display:"flex", alignItems:"flex-start", gap:10,
                padding:"10px 12px",
                background: opt.selected ? "var(--indigo-soft)" : "#fff",
                border: `1px solid ${opt.selected ? "var(--indigo)" : "var(--rule)"}`,
                borderRadius:9, cursor:"pointer",
              }}>
                <input type="radio" name="carry" defaultChecked={opt.selected}
                  style={{ marginTop:3, accentColor:"var(--ink)" }}/>
                <div>
                  <div style={{ fontSize:13, fontWeight:500, color: opt.selected ? "var(--indigo)" : "var(--ink)" }}>{opt.title}</div>
                  <div style={{ fontSize:12, color:"var(--ink-2)", marginTop:2, lineHeight:1.45 }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:4 }}>
          <button className="ns-btn ghost">Cancel</button>
          <button className="ns-btn" style={{ background:"var(--indigo)", borderColor:"var(--indigo)", gap:6 }}>
            <Icons.layers size={12}/> Create project
          </button>
        </div>
      </div>
    </div>
  );
};

// Convenience: chat surface with the modal open over it (for canvas display)
const GenChatWithPromote = () => (
  <GenFrame>
    <GenTopBar promoteHint={true}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden", position:"relative" }}>
      <GenRail/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", filter:"blur(1.5px)", opacity:.8 }}>
        <ConversationHeader/>
        <div style={{ flex:1, overflow:"hidden", padding:"28px 0 0", display:"flex", flexDirection:"column", alignItems:"center", gap:28 }}>
          {GEN_MESSAGES.slice(0, 3).map((m, i) => (
            m.who === "user"
              ? <QuoteBlock key={i} text={m.text}/>
              : <AssistantBlock key={i} text={m.text} model={m.model} web={m.web}/>
          ))}
        </div>
      </div>
      <PromoteModal contained={true}/>
    </div>
  </GenFrame>
);

Object.assign(window, { PromoteModal, GenChatWithPromote });
