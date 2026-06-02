// ws-invites.jsx — invite-friends pill + modal for the workspace top bar.
// Pill shows "Invite · N left" in the top bar. Clicking opens a modal that
// reuses the same invite-card visual language as the post-onboarding screen
// from the sign-in handoff (flows.jsx :: InviteFriends), just compact.

const { Icons } = window;

// Shared fixture — keep counts in sync with the post-onboarding screen (3 each).
const MY_INVITES = [
  { code: "NS-7K2X-MD3F", status: "available" },
  { code: "NS-9PHN-LB2A", status: "available" },
  { code: "NS-4Q6V-Z8RS", status: "available" },
];

// ── Pill that lives in TopBar ──
const InvitePill = ({ count, onClick, h = 28 }) => {
  const Icons = window.Icons;
  return (
  <button onClick={onClick}
    className="ns-btn ghost"
    style={{ height:h, padding:"0 10px", fontSize:12, gap:6, color:"var(--ink-2)", borderColor:"var(--rule-2)", whiteSpace:"nowrap" }}
    title="Share notesci with people whose reading you'd want to learn from">
    {Icons && <Icons.gift size={12}/>}
    <span>Invite</span>
    <span style={{ width:1, height:12, background:"var(--rule-2)" }}/>
    <span className="mono" style={{ color:"var(--muted)", fontSize:11 }}>{count} left</span>
  </button>
  );
};

// ── Single code row ──
const CodeRow = ({ c, last }) => (
  <div style={{ padding:"12px 16px", borderBottom: last ? "none" : "1px solid var(--rule)", display:"flex", alignItems:"center", gap:12 }}>
    <span className="mono" style={{ fontSize:13, letterSpacing:"-.01em", color:"var(--ink)" }}>{c.code}</span>
    <span style={{ flex:1 }}/>
    {c.status === "available" && (
      <>
        <button className="ns-btn ghost tiny">Copy</button>
        <button className="ns-btn tiny">Send</button>
      </>
    )}
    {c.status === "sent" && (
      <span className="mono" style={{ fontSize:10.5, color:"oklch(0.72 0.16 60)", letterSpacing:".08em" }}>· SENT · {c.to}</span>
    )}
    {c.status === "claimed" && (
      <span className="mono" style={{ fontSize:10.5, color:"var(--teal)", letterSpacing:".08em" }}>✓ JOINED · {c.to}</span>
    )}
  </div>
);

// ── Modal body — drops into a centered overlay ──
// `contained` = true keeps the overlay inside its parent (for design-canvas artboards);
// default = position:fixed for real app use.
const InviteModal = ({ onClose, contained = false }) => {
  const codes = MY_INVITES;
  const left  = codes.filter(c => c.status === "available").length;
  const overlay = contained
    ? { position:"absolute", inset:0, background:"rgba(14,17,22,.42)", zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }
    : { position:"fixed",    inset:0, background:"rgba(14,17,22,.42)", zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:24 };
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()}
        className="card"
        style={{ width:520, maxHeight:"calc(100vh - 48px)", background:"var(--paper)", padding:32, position:"relative", display:"flex", flexDirection:"column", gap:20, boxShadow:"0 24px 64px -16px rgba(14,17,22,.32)" }}>
        {/* close */}
        <button onClick={onClose}
          className="ns-btn ghost tiny"
          style={{ position:"absolute", top:14, right:14, padding:"4px 8px", color:"var(--muted)" }}
          aria-label="Close">✕</button>

        {/* header */}
        <div>
          <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:8 }}>SHARE NOTESCI</div>
          <h2 className="serif" style={{ fontSize:30, lineHeight:1.1, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>
            You have <em style={{ color:"var(--indigo)", fontStyle:"normal" }}>{left} {left === 1 ? "invite" : "invites"}</em> to give away.
          </h2>
          <p style={{ fontSize:13.5, color:"#3a342c", lineHeight:1.55, margin:"10px 0 0", maxWidth:420 }}>
            Each notesci member gets 3 invites for the early-access period. Save them for people whose reading you'd want to learn from.
          </p>
        </div>

        {/* invite link */}
        <div style={{ padding:"14px 16px", background:"#fff", border:"1px solid var(--rule)", borderRadius:10 }}>
          <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>YOUR INVITE LINK</div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span className="mono" style={{ fontSize:12.5, color:"var(--ink)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>notesci.com/invite/jin</span>
            <button className="ns-btn tiny">Copy link</button>
          </div>
        </div>

        {/* codes */}
        <div>
          <div style={{ display:"flex", alignItems:"center", marginBottom:8 }}>
            <div className="mono" style={{ fontSize:10.5, letterSpacing:".1em", color:"var(--muted)" }}>YOUR CODES · 3 ALLOCATED · {left} LEFT</div>
            <a href="#" style={{ marginLeft:"auto", fontSize:12, color:"var(--muted)" }}>How invites work →</a>
          </div>
          <div style={{ background:"#fff", border:"1px solid var(--rule)", borderRadius:10, overflow:"hidden" }}>
            {codes.map((c, i) => <CodeRow key={c.code} c={c} last={i === codes.length - 1}/>)}
          </div>
          <p style={{ fontSize:11.5, color:"var(--muted)", marginTop:12, lineHeight:1.5 }}>
            Codes expire 14 days after they're sent. Unclaimed codes return to your pool.
          </p>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { InvitePill, InviteModal, MY_INVITES });
