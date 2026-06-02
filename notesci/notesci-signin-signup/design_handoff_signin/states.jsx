// states.jsx — loading + inline-error states & post-send toast.
//
// These are display-only stencils, but the Sign-in artboard demonstrates
// a real working state-machine using local state so the dev can see the
// expected interaction.

const { Lockup } = window;
const { Field, SocialBtn, ICON } = window;

// Inline error pattern — red border + small message under the field.
const ErrField = ({ label, error, children, hint }) => (
  <label style={{ display:"flex", flexDirection:"column", gap:6 }}>
    <span className="mono" style={{ fontSize:10.5, letterSpacing:".1em", color:"var(--muted)", textTransform:"uppercase" }}>{label}</span>
    {children}
    {error && (
      <span style={{ fontSize:11.5, color:"oklch(0.55 0.20 25)", display:"flex", alignItems:"center", gap:6 }}>
        <span style={{ display:"inline-flex", width:14, height:14, borderRadius:7, background:"oklch(0.55 0.20 25)", color:"white", fontSize:10, fontWeight:700, alignItems:"center", justifyContent:"center" }}>!</span>
        {error}
      </span>
    )}
    {!error && hint && <span style={{ fontSize:11.5, color:"var(--muted)" }}>{hint}</span>}
  </label>
);

const errorInputStyle = { border:"1px solid oklch(0.55 0.20 25)", boxShadow:"0 0 0 3px color-mix(in oklch, oklch(0.55 0.20 25) 18%, transparent)" };

// ─────────── Sign-in · loading state ───────────
const SignInLoading = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column", height:"100%" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>SIGN IN</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Pick up where you left off.</h1>
        </div>
        <Field label="Email"><input className="ns-input" defaultValue="jin@brown.edu" disabled/></Field>
        <Field label="Password"><input className="ns-input" type="password" defaultValue="••••••••••••" disabled/></Field>
        <button className="ns-btn full" disabled style={{ opacity:.85 }}>
          <span style={{ display:"inline-block", width:14, height:14, border:"2px solid currentColor", borderTopColor:"transparent", borderRadius:7, animation:"spin360 .8s linear infinite", marginRight:8 }}/>
          Signing in…
        </button>
      </div>
      <div style={{ flex:1 }}/>
    </div>
    <div style={{ background:"var(--paper-2)", borderLeft:"1px solid var(--rule)" }}/>
  </div>
);

// ─────────── Sign-in · wrong password ───────────
const SignInError = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column", height:"100%" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>SIGN IN</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Pick up where you left off.</h1>
        </div>
        {/* Top-of-form alert */}
        <div style={{ display:"flex", gap:10, padding:"12px 14px", background:"color-mix(in oklch, oklch(0.55 0.20 25) 8%, white)", border:"1px solid color-mix(in oklch, oklch(0.55 0.20 25) 35%, transparent)", borderRadius:10, alignItems:"flex-start" }}>
          <span style={{ display:"inline-flex", width:18, height:18, borderRadius:9, background:"oklch(0.55 0.20 25)", color:"white", fontSize:11, fontWeight:700, alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:1 }}>!</span>
          <div style={{ fontSize:13, color:"oklch(0.42 0.18 25)", lineHeight:1.45 }}>
            <strong>That email and password don't match.</strong><br/>
            Try again, or <a href="#" style={{ color:"oklch(0.42 0.18 25)" }}>reset your password</a>.
          </div>
        </div>
        <Field label="Email"><input className="ns-input" defaultValue="jin@brown.edu"/></Field>
        <ErrField label="Password" error="Incorrect password.">
          <input className="ns-input" type="password" defaultValue="••••••••••••" style={errorInputStyle}/>
        </ErrField>
        <button className="ns-btn full">Sign in</button>
      </div>
      <div style={{ flex:1 }}/>
    </div>
    <div style={{ background:"var(--paper-2)", borderLeft:"1px solid var(--rule)" }}/>
  </div>
);

// ─────────── Sign-up · invalid invite code ───────────
const SignUpInvalidCode = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column", height:"100%" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>CLAIM YOUR INVITE</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Welcome to the lab notebook.</h1>
        </div>
        <ErrField label="Invite code" error="That code isn't valid. Double-check the email you got.">
          <input className="ns-input mono" defaultValue="NS-XXXX" style={{ ...errorInputStyle, letterSpacing:".15em", textTransform:"uppercase" }}/>
        </ErrField>
        <Field label="Email"><input className="ns-input" placeholder="you@university.edu"/></Field>
        <Field label="Password" hint="12+ characters"><input className="ns-input" type="password" placeholder="••••••••••••"/></Field>
        <button className="ns-btn full">Claim my account</button>
        <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center" }}>No invite? <a href="#" style={{ color:"var(--ink)" }}>Join the waitlist</a></div>
      </div>
      <div style={{ flex:1 }}/>
    </div>
    <div style={{ background:"var(--paper-2)", borderLeft:"1px solid var(--rule)" }}/>
  </div>
);

// ─────────── Sign-up · email already in use ───────────
const SignUpEmailExists = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <div style={{ padding:"56px 72px", display:"flex", flexDirection:"column", height:"100%" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>CLAIM YOUR INVITE</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>Welcome to the lab notebook.</h1>
        </div>
        <Field label="Invite code" hint="✓ invite valid">
          <input className="ns-input mono" defaultValue="NS-7K2X" style={{ letterSpacing:".15em", textTransform:"uppercase" }}/>
        </Field>
        <ErrField label="Email" error={<>This email already has an account. <a href="#" style={{ color:"oklch(0.42 0.18 25)" }}>Sign in instead?</a></>}>
          <input className="ns-input" defaultValue="jin@brown.edu" style={errorInputStyle}/>
        </ErrField>
        <Field label="Password" hint="12+ characters"><input className="ns-input" type="password" placeholder="••••••••••••"/></Field>
        <button className="ns-btn full">Claim my account</button>
      </div>
      <div style={{ flex:1 }}/>
    </div>
    <div style={{ background:"var(--paper-2)", borderLeft:"1px solid var(--rule)" }}/>
  </div>
);

// ─────────── Invite-friends · empty + sent toast ───────────
const InviteFriendsEmpty = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, background:"var(--paper)", display:"flex", flexDirection:"column", padding:"40px 56px" }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ display:"flex", alignItems:"center", gap:12, fontSize:13, color:"var(--muted)" }}>
        <span>Library</span><span>Drafts</span><span style={{ color:"var(--ink)", fontWeight:500 }}>Invites</span>
        <div style={{ width:32, height:32, borderRadius:16, background:"var(--indigo)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:600 }}>JP</div>
      </div>
    </div>
    <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", textAlign:"center", gap:18, maxWidth:520, margin:"0 auto" }}>
      <div style={{ width:80, height:80, borderRadius:40, background:"color-mix(in oklch, var(--indigo) 12%, transparent)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--indigo)", fontSize:36 }}>✉</div>
      <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)" }}>NO INVITES SENT YET</div>
      <h1 className="serif" style={{ fontSize:42, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>You have <em style={{ color:"var(--indigo)" }}>5 invites</em> to share.</h1>
      <p style={{ fontSize:15, color:"#3a342c", margin:0, lineHeight:1.55 }}>Save them for people whose reading you'd want to learn from. Each member of the early-access cohort gets the same allocation.</p>
      <button className="ns-btn">Send your first invite</button>
    </div>
  </div>
);

// ─────────── Invite sent · toast over the table ───────────
const InviteSentToast = ({ width = 1440, height = 900 }) => (
  <div style={{ width, height, background:"var(--paper)", position:"relative", display:"flex", flexDirection:"column", padding:"40px 56px" }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ display:"flex", alignItems:"center", gap:12, fontSize:13, color:"var(--muted)" }}>
        <span>Library</span><span>Drafts</span><span style={{ color:"var(--ink)", fontWeight:500 }}>Invites</span>
        <div style={{ width:32, height:32, borderRadius:16, background:"var(--indigo)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:600 }}>JP</div>
      </div>
    </div>
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ display:"flex", flexDirection:"column", gap:10, alignItems:"center" }}>
        <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)" }}>(table of codes here…)</div>
      </div>
    </div>
    {/* toast */}
    <div style={{ position:"absolute", bottom:32, left:"50%", transform:"translateX(-50%)", display:"flex", alignItems:"center", gap:12, padding:"14px 20px", background:"var(--ink)", color:"var(--paper)", borderRadius:12, boxShadow:"0 16px 40px rgba(0,0,0,.18)" }}>
      <span style={{ display:"inline-flex", width:20, height:20, borderRadius:10, background:"var(--teal-bright, oklch(0.78 0.18 195))", color:"var(--ink)", fontSize:12, fontWeight:700, alignItems:"center", justifyContent:"center" }}>✓</span>
      <span style={{ fontSize:14 }}>Invite sent to <strong>lia@harvard.edu</strong>. Code <span className="mono" style={{ letterSpacing:".15em" }}>NS-Q21T</span> is reserved for 14 days.</span>
      <span style={{ fontSize:13, color:"rgba(255,255,255,.6)", marginLeft:8 }}>Undo</span>
    </div>
  </div>
);

Object.assign(window, { SignInLoading, SignInError, SignUpInvalidCode, SignUpEmailExists, InviteFriendsEmpty, InviteSentToast, ErrField });
