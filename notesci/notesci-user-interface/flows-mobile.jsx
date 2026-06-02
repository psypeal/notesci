// flows-mobile.jsx — mobile (390×844) versions of the adjacent screens.
// Same editorial language, single-column composition.

const { Lockup, Mark } = window;
const { Field, SocialBtn, ICON } = window;

// Centered status frame · mobile
const StatusFrameM = ({ kind = "info", eyebrow, headline, body, primary, secondary }) => {
  const accents = { success:"var(--teal)", info:"var(--indigo)", warn:"oklch(0.72 0.16 60)", error:"oklch(0.55 0.20 25)" };
  const accent = accents[kind] || accents.info;
  return (
    <div style={{ width:390, height:844, background:"var(--paper)", padding:"32px 28px", display:"flex", flexDirection:"column" }}>
      <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", textAlign:"center", gap:16 }}>
        <div style={{ width:60, height:60, borderRadius:30, background:"color-mix(in oklch, "+accent+" 18%, transparent)", display:"flex", alignItems:"center", justifyContent:"center", color:accent, fontSize:28 }}>
          {kind === "success" ? "✓" : kind === "warn" ? "!" : kind === "error" ? "×" : "✉"}
        </div>
        <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)" }}>{eyebrow}</div>
        <h1 className="serif" style={{ fontSize:30, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>{headline}</h1>
        <p style={{ fontSize:14, color:"#3a342c", margin:0, lineHeight:1.55 }}>{body}</p>
        <div style={{ display:"flex", flexDirection:"column", gap:8, width:"100%", marginTop:8 }}>
          {primary && <button className="ns-btn full">{primary}</button>}
          {secondary && <button className="ns-btn ghost full">{secondary}</button>}
        </div>
      </div>
    </div>
  );
};

const ForgotPasswordM = () => (
  <div style={{ width:390, height:844, background:"var(--paper)", padding:"32px 28px", display:"flex", flexDirection:"column", gap:18 }}>
    <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
    <div style={{ marginTop:8 }}>
      <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>RESET PASSWORD</div>
      <h1 className="serif" style={{ fontSize:30, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Forgot your password?</h1>
      <p style={{ fontSize:13, color:"var(--muted)", margin:"8px 0 0", lineHeight:1.5 }}>We'll send a reset link. Links expire in 30 minutes.</p>
    </div>
    <Field label="Email"><input className="ns-input" defaultValue="jin@brown.edu"/></Field>
    <button className="ns-btn full">Send reset link</button>
    <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center", marginTop:"auto" }}>Remembered? <a href="#" style={{ color:"var(--ink)" }}>Back to sign in</a></div>
  </div>
);

const ResetSentM = () => (
  <StatusFrameM kind="info" eyebrow="CHECK YOUR INBOX"
    headline={<>Reset link sent.</>}
    body={<>We sent a link to <em>jin@brown.edu</em>. It expires in 30 minutes.</>}
    primary="Open mail app" secondary="Use a different email"/>
);

const SetNewPasswordM = () => (
  <div style={{ width:390, height:844, background:"var(--paper)", padding:"32px 28px", display:"flex", flexDirection:"column", gap:16 }}>
    <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
    <div style={{ marginTop:8 }}>
      <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>NEW PASSWORD</div>
      <h1 className="serif" style={{ fontSize:30, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Set a new password.</h1>
      <p style={{ fontSize:13, color:"var(--muted)", margin:"8px 0 0", lineHeight:1.5 }}>12+ characters.</p>
    </div>
    <Field label="New password"><input className="ns-input" type="password" defaultValue="••••••••••••••"/></Field>
    <Field label="Confirm"><input className="ns-input" type="password" defaultValue="••••••••••••••"/></Field>
    <div style={{ display:"flex", gap:6, alignItems:"center", fontSize:12, color:"var(--muted)" }}>
      <div style={{ display:"flex", gap:3, flex:1 }}>
        {[1,2,3,4].map(i => <div key={i} style={{ flex:1, height:4, borderRadius:2, background: i <= 3 ? "var(--teal)" : "rgba(14,17,22,.12)" }}/>)}
      </div>
      <span>Strong</span>
    </div>
    <button className="ns-btn full">Save and sign in</button>
  </div>
);

const VerifyEmailM = () => (
  <StatusFrameM kind="info" eyebrow="ONE LAST STEP"
    headline={<>Verify your email.</>}
    body={<>We sent a verification link to <em>jin@brown.edu</em>.</>}
    primary="Resend" secondary="Use a different email"/>
);

const InviteLandingM = () => (
  <div style={{ width:390, height:844, background:"var(--paper)", padding:"32px 28px", display:"flex", flexDirection:"column", gap:18 }}>
    <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
    <div style={{ marginTop:12 }}>
      <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>YOU'VE BEEN INVITED</div>
      <h1 className="serif" style={{ fontSize:32, lineHeight:1.05, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>A seat is reserved <em style={{ color:"var(--indigo)" }}>for you.</em></h1>
      <p style={{ fontSize:13, color:"#3a342c", margin:"10px 0 0", lineHeight:1.55 }}>Your invite code is below. Tied to this link.</p>
    </div>
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:"#fff", border:"1px solid var(--rule)", borderRadius:12 }}>
      <div className="mono" style={{ fontSize:18, letterSpacing:".22em", fontWeight:600 }}>NS-7K2X</div>
      <div style={{ flex:1 }}/>
      <span className="mono" style={{ fontSize:10, color:"var(--teal)", letterSpacing:".1em" }}>✓ VALID</span>
    </div>
    <button className="ns-btn full">Claim my account</button>
    <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center", marginTop:"auto" }}>Already have an account? <a href="#" style={{ color:"var(--ink)" }}>Sign in instead</a></div>
  </div>
);

const AlreadyClaimedM = () => (
  <StatusFrameM kind="warn" eyebrow="INVITE ALREADY USED"
    headline="This code was already claimed."
    body={<>Codes are single-use. If you already have an account, sign in.</>}
    primary="Go to sign in" secondary="Join waitlist instead"/>
);
const ExpiredInviteM = () => (
  <StatusFrameM kind="error" eyebrow="INVITE EXPIRED"
    headline="This invite has expired."
    body="Codes are valid for 14 days. Ask for a fresh one or join the waitlist."
    primary="Request a new invite" secondary="Join the waitlist"/>
);

const OnboardingM = () => (
  <div style={{ width:390, height:844, background:"var(--paper)", padding:"32px 28px", display:"flex", flexDirection:"column", gap:14, overflow:"hidden" }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
      <a href="#" className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)" }}>SKIP</a>
    </div>
    <div style={{ marginTop:4 }}>
      <div className="mono" style={{ fontSize:10.5, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>STEP 1 · SKIPPABLE</div>
      <h1 className="serif" style={{ fontSize:28, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>About your work.</h1>
      <p style={{ fontSize:13, color:"#3a342c", margin:"8px 0 0", lineHeight:1.5 }}>All optional. Skip what you'd rather fill in later.</p>
    </div>
    <Field label="Name"><input className="ns-input" placeholder="Jin Park"/></Field>
    <Field label="Affiliation"><input className="ns-input" placeholder="Brown · CLPS"/></Field>
    <Field label="Field of research"><input className="ns-input" placeholder="Cognitive science"/></Field>
    <Field label="Topics"><input className="ns-input" placeholder="working memory, RLHF"/></Field>
    <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:"auto" }}>
      <button className="ns-btn full">Save and continue</button>
      <button className="ns-btn ghost full">Skip everything for now</button>
    </div>
  </div>
);

// Invite-friends mobile — stacks the share card above the codes list
const InviteFriendsM = () => {
  const codes = [
    { code: "NS-7K2X", status: "available" },
    { code: "NS-3MP9", status: "available" },
    { code: "NS-WB4F", status: "available" },
    { code: "NS-Q21T", status: "sent",     to: "lia@harvard.edu" },
    { code: "NS-V8XR", status: "claimed",  to: "marco@mit.edu" },
  ];
  return (
    <div style={{ width:390, height:844, background:"var(--paper)", padding:"24px 24px", display:"flex", flexDirection:"column", gap:14, overflow:"hidden" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Lockup variant="split" size={16} colorN="var(--indigo)" colorS="var(--teal)"/>
        <div style={{ width:28, height:28, borderRadius:14, background:"var(--indigo)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:600 }}>JP</div>
      </div>
      <div className="mono" style={{ fontSize:10.5, letterSpacing:".1em", color:"var(--muted)" }}>SHARE NOTESCI</div>
      <h1 className="serif" style={{ fontSize:26, lineHeight:1.1, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>You have <em style={{ color:"var(--indigo)" }}>3 invites</em> left.</h1>
      <div style={{ padding:"14px 16px", background:"#fff", border:"1px solid var(--rule)", borderRadius:12 }}>
        <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>YOUR INVITE LINK</div>
        <div className="mono" style={{ fontSize:11, color:"var(--ink)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:8 }}>notesci.com/invite/jin?c=NS-7K2X</div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="ns-btn ghost" style={{ flex:1, padding:"6px", fontSize:12 }}>Copy</button>
          <button className="ns-btn" style={{ flex:1, padding:"6px", fontSize:12 }}>Share</button>
        </div>
      </div>
      <div className="mono" style={{ fontSize:10, letterSpacing:".1em", color:"var(--muted)", marginTop:4 }}>3 ALLOCATED · 3 LEFT</div>
      <div style={{ background:"#fff", border:"1px solid var(--rule)", borderRadius:12, overflow:"hidden", flex:1 }}>
        {codes.map((c, i) => (
          <div key={c.code} style={{ display:"flex", alignItems:"center", padding:"12px 14px", borderTop: i ? "1px solid var(--rule)" : "none", gap:10 }}>
            <div className="mono" style={{ fontSize:12, letterSpacing:".15em", fontWeight:600, width:80 }}>{c.code}</div>
            <div style={{ fontSize:11.5, color: c.status === "available" ? "var(--muted)" : "var(--ink)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {c.status === "available" ? "—" : c.to}
            </div>
            {c.status === "available" && <button className="ns-btn ghost" style={{ padding:"3px 8px", fontSize:10.5 }}>Send</button>}
            {c.status === "sent" && <span className="mono" style={{ fontSize:9.5, color:"oklch(0.72 0.16 60)", letterSpacing:".06em" }}>SENT</span>}
            {c.status === "claimed" && <span className="mono" style={{ fontSize:9.5, color:"var(--teal)", letterSpacing:".06em" }}>✓ JOINED</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, {
  ForgotPasswordM, ResetSentM, SetNewPasswordM, VerifyEmailM,
  InviteLandingM, AlreadyClaimedM, ExpiredInviteM,
  OnboardingM, InviteFriendsM,
});
