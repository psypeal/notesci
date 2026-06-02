// flows.jsx — adjacent screens for the V1 sign-in flow.
//
// All adopt the same editorial split-layout language as signin.jsx so the
// whole flow feels like one document. Smaller "utility" screens use a
// centered single-column composition on the same paper background.

const { Mark, Lockup } = window;
const { Hero, Field, SocialBtn, ICON } = window;

// ─────────── Centered status frame (used by reset-sent, verify, errors) ───────────
const StatusFrame = ({ width = 1440, height = 900, kind = "info", eyebrow, headline, body, primary, secondary, mark }) => {
  const accents = {
    success: "var(--teal)",
    info:    "var(--indigo)",
    warn:    "oklch(0.72 0.16 60)",
    error:   "oklch(0.55 0.20 25)",
  };
  const accent = accents[kind] || accents.info;
  return (
    <div style={{ width, height, background:"var(--paper)", display:"flex", flexDirection:"column", padding:"40px 56px" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ maxWidth:520, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:20 }}>
          {mark || (
            <div style={{ width:72, height:72, borderRadius:36, background:"color-mix(in oklch, " + accent + " 18%, transparent)", display:"flex", alignItems:"center", justifyContent:"center", color:accent, fontSize:32 }}>
              {kind === "success" ? "✓" : kind === "warn" ? "!" : kind === "error" ? "×" : "✉"}
            </div>
          )}
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)" }}>{eyebrow}</div>
          <h1 className="serif" style={{ fontSize:42, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>{headline}</h1>
          <p style={{ fontSize:15, color:"#3a342c", margin:0, lineHeight:1.55, maxWidth:440 }}>{body}</p>
          {(primary || secondary) && (
            <div style={{ display:"flex", gap:10, marginTop:12 }}>
              {primary && <button className="ns-btn">{primary}</button>}
              {secondary && <button className="ns-btn ghost">{secondary}</button>}
            </div>
          )}
        </div>
      </div>
      <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em", display:"flex", gap:18 }}>
        <span>© 2026 notesci</span><span>privacy</span><span>terms</span>
      </div>
    </div>
  );
};

// ─────────── Forgot password (request reset) ───────────
const ForgotPassword = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>RESET PASSWORD</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Forgot your password?</h1>
          <p style={{ fontSize:14, color:"var(--muted)", margin:"10px 0 0", lineHeight:1.55 }}>Type your email and we'll send a reset link. Links expire in 30 minutes.</p>
        </div>
        <Field label="Email"><input className="ns-input" defaultValue="jin@brown.edu"/></Field>
        <button className="ns-btn full">Send reset link</button>
        <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center" }}>Remembered? <a href="#" style={{ color:"var(--ink)" }}>Back to sign in</a></div>
      </div>
      <div style={{ flex:1 }}/>
      <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em", display:"flex", gap:18 }}>
        <span>© 2026 notesci</span><span>privacy</span><span>terms</span>
      </div>
    </div>
    <Hero treatment="pullquote" showIssue={true} showStats={false}/>
  </div>
);

// ─────────── Reset link sent ───────────
const ResetSent = ({ width = 1440, height = 900 }) => (
  <StatusFrame
    width={width} height={height} kind="info"
    eyebrow="CHECK YOUR INBOX"
    headline={<>We sent a reset link to<br/><span style={{ fontStyle:"italic", color:"var(--indigo)" }}>jin@brown.edu</span></>}
    body="The link expires in 30 minutes. If you don't see it, check spam or try a different address."
    primary="Open mail app"
    secondary="Use a different email"
  />
);

// ─────────── Set new password (after clicking reset link) ───────────
const SetNewPassword = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>NEW PASSWORD</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Set a new password.</h1>
          <p style={{ fontSize:14, color:"var(--muted)", margin:"10px 0 0", lineHeight:1.55 }}>Choose a strong, memorable phrase. 12+ characters.</p>
        </div>
        <Field label="New password" hint="At least 12 characters"><input className="ns-input" type="password" defaultValue="••••••••••••••"/></Field>
        <Field label="Confirm password"><input className="ns-input" type="password" defaultValue="••••••••••••••"/></Field>
        <div style={{ display:"flex", gap:6, alignItems:"center", fontSize:12, color:"var(--muted)" }}>
          <div style={{ display:"flex", gap:3, flex:1 }}>
            {[1,2,3,4].map(i => <div key={i} style={{ flex:1, height:4, borderRadius:2, background: i <= 3 ? "var(--teal)" : "rgba(14,17,22,.12)" }}/>)}
          </div>
          <span>Strong</span>
        </div>
        <button className="ns-btn full">Save and sign in</button>
      </div>
      <div style={{ flex:1 }}/>
      <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em", display:"flex", gap:18 }}>
        <span>© 2026 notesci</span><span>privacy</span><span>terms</span>
      </div>
    </div>
    <Hero treatment="mark" showIssue={false} showStats={false}/>
  </div>
);

// ─────────── Verify email (after sign-up) ───────────
const VerifyEmail = ({ width = 1440, height = 900 }) => (
  <StatusFrame
    width={width} height={height} kind="info"
    eyebrow="ONE LAST STEP"
    headline={<>Verify your email to<br/>activate your account.</>}
    body={<>We sent a verification link to <em>jin@brown.edu</em>. Click it to finish setting up your notesci account.</>}
    primary="Resend verification"
    secondary="Use a different email"
  />
);

// ─────────── Invite-link landing (URL had a code in it) ───────────
const InviteLanding = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:400, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>YOU'VE BEEN INVITED</div>
          <h1 className="serif" style={{ fontSize:46, lineHeight:1.05, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>A seat is reserved <em style={{ color:"var(--indigo)" }}>for you.</em></h1>
          <p style={{ fontSize:14.5, color:"#3a342c", margin:"14px 0 0", lineHeight:1.55 }}>Your invite code is below. It's tied to this link — claim it on this device, or copy the code if you want to claim later.</p>
        </div>
        {/* Code chip */}
        <div style={{ display:"flex", alignItems:"center", gap:14, padding:"18px 20px", background:"#fff", border:"1px solid var(--rule)", borderRadius:12 }}>
          <div className="mono" style={{ fontSize:22, letterSpacing:".25em", fontWeight:600 }}>NS-7K2X</div>
          <div style={{ flex:1 }}/>
          <span className="mono" style={{ fontSize:11, color:"var(--teal)", letterSpacing:".1em" }}>✓ VALID</span>
          <button className="ns-btn ghost" style={{ padding:"6px 10px", fontSize:12 }}>Copy</button>
        </div>
        <button className="ns-btn full">Claim my account</button>
        <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center" }}>Already have an account? <a href="#" style={{ color:"var(--ink)" }}>Sign in instead</a></div>
      </div>
      <div style={{ flex:1 }}/>
      <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em", display:"flex", gap:18 }}>
        <span>© 2026 notesci</span><span>privacy</span><span>terms</span>
      </div>
    </div>
    <Hero treatment="headline" headline="A small, private network of curious researchers." showStats={true} showIssue={true}/>
  </div>
);

// ─────────── Errors (already-claimed, expired) ───────────
const AlreadyClaimed = ({ width = 1440, height = 900 }) => (
  <StatusFrame
    width={width} height={height} kind="warn"
    eyebrow="INVITE ALREADY USED"
    headline="This code was already claimed."
    body={<>Codes are single-use. If you already have an account, sign in. If you think this is a mistake, contact <a href="#" style={{ color:"var(--ink)" }}>support@notesci.com</a>.</>}
    primary="Go to sign in"
    secondary="Join waitlist instead"
  />
);
const ExpiredInvite = ({ width = 1440, height = 900 }) => (
  <StatusFrame
    width={width} height={height} kind="error"
    eyebrow="INVITE EXPIRED"
    headline="This invite has expired."
    body="Invite codes are valid for 14 days. Ask the person who invited you for a fresh one, or join the waitlist."
    primary="Request a new invite"
    secondary="Join the waitlist"
  />
);

// ─────────── Post-claim onboarding (single skippable step) ───────────
const Onboarding = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, background:"var(--paper)", display:"flex", flexDirection:"column", padding:"40px 56px" }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <a href="#" className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)" }}>SKIP · ADD LATER</a>
    </div>
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:560, display:"flex", flexDirection:"column", gap:24 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>STEP 1 OF 1 · SKIPPABLE</div>
          <h1 className="serif" style={{ fontSize:46, lineHeight:1.1, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>Tell us a little about your work.</h1>
          <p style={{ fontSize:15, color:"#3a342c", margin:"10px 0 0", lineHeight:1.55 }}>Helps us tune your library, citations, and recommendations. Every field is optional — skip what you'd rather fill in later.</p>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          <Field label="Name" action={<a href="#" className="mono" style={{ color:"var(--muted)", letterSpacing:".06em", fontSize:10.5 }}>SKIP</a>}><input className="ns-input" placeholder="Jin Park"/></Field>
          <Field label="Affiliation" action={<a href="#" className="mono" style={{ color:"var(--muted)", letterSpacing:".06em", fontSize:10.5 }}>SKIP</a>}><input className="ns-input" placeholder="Brown · CLPS"/></Field>
          <Field label="ORCID iD" hint="orcid.org/0000-…" action={<a href="#" className="mono" style={{ color:"var(--muted)", letterSpacing:".06em", fontSize:10.5 }}>SKIP</a>}><input className="ns-input mono" placeholder="0000-0002-…"/></Field>
          <Field label="Field of research" action={<a href="#" className="mono" style={{ color:"var(--muted)", letterSpacing:".06em", fontSize:10.5 }}>SKIP</a>}><input className="ns-input" placeholder="Cognitive science"/></Field>
        </div>
        <Field label="Topics you're following" hint="Comma-separated · helps with feed">
          <input className="ns-input" placeholder="transformer interpretability, working memory, RLHF"/>
        </Field>
        <div style={{ display:"flex", gap:10, marginTop:8 }}>
          <button className="ns-btn">Save and continue</button>
          <button className="ns-btn ghost">Skip everything for now</button>
        </div>
      </div>
    </div>
    <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em", display:"flex", gap:18 }}>
      <span>© 2026 notesci</span><span>privacy</span><span>terms</span>
    </div>
  </div>
);

// ─────────── In-app: invite friends ───────────
const InviteFriends = ({ width = 1440, height = 900 }) => {
  const codes = [
    { code: "NS-7K2X", status: "available" },
    { code: "NS-3MP9", status: "available" },
    { code: "NS-WB4F", status: "available" },
    { code: "NS-Q21T", status: "sent",     to: "lia@harvard.edu", date: "Apr 28" },
    { code: "NS-V8XR", status: "claimed",  to: "marco@mit.edu",   date: "Apr 14" },
  ];
  return (
    <div style={{ width, height, background:"var(--paper)", display:"flex", flexDirection:"column", padding:"40px 56px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
        <div style={{ display:"flex", alignItems:"center", gap:12, fontSize:13, color:"var(--muted)" }}>
          <span>Library</span><span>Drafts</span><span style={{ color:"var(--ink)", fontWeight:500 }}>Invites</span>
          <div style={{ width:32, height:32, borderRadius:16, background:"var(--indigo)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:600 }}>JP</div>
        </div>
      </div>
      <div style={{ flex:1, display:"grid", gridTemplateColumns:"1fr 1.2fr", gap:64, paddingTop:48 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:10 }}>SHARE NOTESCI</div>
          <h1 className="serif" style={{ fontSize:48, lineHeight:1.05, letterSpacing:"-0.025em", margin:"0 0 16px", fontWeight:500 }}>You have <em style={{ color:"var(--indigo)" }}>3 invites</em> to give out.</h1>
          <p style={{ fontSize:15, color:"#3a342c", lineHeight:1.55, maxWidth:420 }}>Each notesci member gets 5 invites for the early-access period. Use them on people whose reading you'd want to learn from.</p>
          <div style={{ marginTop:32, padding:"20px 24px", background:"#fff", border:"1px solid var(--rule)", borderRadius:14 }}>
            <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:10 }}>YOUR INVITE LINK</div>
            <div style={{ display:"flex", gap:10, alignItems:"center" }}>
              <div className="mono" style={{ flex:1, fontSize:13, color:"var(--ink)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>notesci.com/invite/jin?c=NS-7K2X</div>
              <button className="ns-btn ghost" style={{ padding:"6px 12px", fontSize:12 }}>Copy</button>
              <button className="ns-btn" style={{ padding:"6px 12px", fontSize:12 }}>Share</button>
            </div>
          </div>
        </div>
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)" }}>YOUR CODES · 5 ALLOCATED · 3 LEFT</div>
            <a href="#" style={{ fontSize:12, color:"var(--muted)" }}>How invites work →</a>
          </div>
          <div style={{ background:"#fff", border:"1px solid var(--rule)", borderRadius:14, overflow:"hidden" }}>
            {codes.map((c, i) => (
              <div key={c.code} style={{ display:"grid", gridTemplateColumns:"160px 1fr 100px 90px", gap:16, alignItems:"center", padding:"16px 20px", borderTop: i ? "1px solid var(--rule)" : "none" }}>
                <div className="mono" style={{ fontSize:14, letterSpacing:".18em", fontWeight:600 }}>{c.code}</div>
                <div style={{ fontSize:13, color: c.status === "available" ? "var(--muted)" : "var(--ink)" }}>
                  {c.status === "available" ? "—" : c.to}
                </div>
                <div style={{ fontSize:11.5, color:"var(--muted)" }}>{c.date || ""}</div>
                <div style={{ textAlign:"right" }}>
                  {c.status === "available" && <button className="ns-btn ghost" style={{ padding:"4px 10px", fontSize:11.5 }}>Send</button>}
                  {c.status === "sent" && <span className="mono" style={{ fontSize:10.5, color:"oklch(0.72 0.16 60)", letterSpacing:".08em" }}>· SENT</span>}
                  {c.status === "claimed" && <span className="mono" style={{ fontSize:10.5, color:"var(--teal)", letterSpacing:".08em" }}>✓ JOINED</span>}
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize:12, color:"var(--muted)", marginTop:16, lineHeight:1.5 }}>
            Codes expire 14 days after they're sent. Unclaimed codes return to your pool automatically.
          </p>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, {
  ForgotPassword, ResetSent, SetNewPassword, VerifyEmail,
  InviteLanding, AlreadyClaimed, ExpiredInvite,
  Onboarding, InviteFriends, StatusFrame,
});
