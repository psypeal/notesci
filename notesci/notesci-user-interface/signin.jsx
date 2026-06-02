// signin.jsx — V1 "Editorial" sign-in / sign-up flow for notesci
//
// We've committed to V1 (split layout, serif headline + paper-textured
// hero on the right, mono section labels). This file owns:
//   - shared form atoms (Field, SocialBtn, ICON, copy maps)
//   - the V1 main component (parameterized: mode + tweakable hero)
//   - mobile + tablet variants of V1
//
// Adjacent screens (forgot password, reset, verify, onboarding,
// invite-link landing, errors, invite-share) live in flows.jsx so we can
// keep each file under a couple hundred lines.

const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window;
const { Mark, Wordmark, Lockup } = window;
const { TweaksPanel, useTweaks, TweakSection, TweakRadio, TweakToggle, TweakSelect, TweakText } = window;

// ─── Defaults exposed via Tweaks panel ───
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "mode": "signin",
  "paper": "warm",
  "showStats": true,
  "showIssue": true,
  "heroTreatment": "headline",
  "headline": "Read, query, and draft from a single source of truth."
}/*EDITMODE-END*/;

// ─────────── Auth method icons (inline SVG) ───────────
const ICON = {
  google: <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285f4" d="M22.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.22-4.74 3.22-8.11z"/><path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fbbc04" d="M5.84 14.1A6.97 6.97 0 0 1 5.45 12c0-.73.13-1.43.36-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.66-2.84z"/><path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>,
  github: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.65 3 8.6 7.18 9.99.52.1.71-.23.71-.5v-1.7c-2.92.63-3.54-1.4-3.54-1.4-.48-1.21-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.05.07 1.6 1.08 1.6 1.08.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.67-1.4-2.33-.27-4.78-1.17-4.78-5.2 0-1.15.41-2.08 1.08-2.82-.1-.27-.47-1.34.1-2.78 0 0 .88-.28 2.88 1.08A10 10 0 0 1 12 6.84c.89 0 1.78.12 2.62.35 2-1.36 2.88-1.08 2.88-1.08.57 1.44.21 2.51.1 2.78.67.74 1.08 1.67 1.08 2.82 0 4.04-2.46 4.93-4.8 5.19.38.32.71.96.71 1.95v2.88c0 .28.19.6.71.5A10.5 10.5 0 0 0 22.5 12C22.5 6.2 17.8 1.5 12 1.5z"/></svg>,
  orcid: <svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#a6ce39"/><text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="Inter Tight,sans-serif">iD</text></svg>,
  inst: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 2 8.5 12 14l10-5.5L12 3z"/><path d="M6 11v5c0 1 2.5 3 6 3s6-2 6-3v-5"/></svg>,
};

// ─────────── Shared form atoms ───────────
const Field = ({ label, children, hint, action }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <span style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
      <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".1em", color: "var(--muted)", textTransform: "uppercase" }}>{label}</span>
      {action && <span style={{ fontSize:11.5 }}>{action}</span>}
    </span>
    {children}
    {hint && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{hint}</span>}
  </label>
);

const SocialBtn = ({ icon, label }) => (
  <button className="ns-btn ghost" style={{ flex: 1, background:"#fff" }}>
    {icon}<span>{label}</span>
  </button>
);

// Mode-driven copy. Keeping this as a map (not inline ternaries) so the
// adjacent-screen files can reuse the same vocabulary.
const COPY = {
  signin:   { eyebrow: "SIGN IN",          h1: "Pick up where you left off.",   sub: "Sign in to your library, drafts, and citations." },
  signup:   { eyebrow: "CLAIM YOUR INVITE", h1: "Welcome to the lab notebook.",  sub: "notesci is invite-only during early testing. Paste your code to claim your spot." },
  waitlist: { eyebrow: "JOIN THE WAITLIST", h1: "We'll save you a seat.",        sub: "Drop your details and we'll reach out when invites open up in your field." },
};

// ─────────── Hero (right panel) — parameterized for tweaks ───────────
const Hero = ({ paper = "warm", showStats = true, showIssue = true, treatment = "headline", headline }) => {
  const bg = paper === "sepia" ? "oklch(0.92 0.04 75)" : paper === "cool" ? "oklch(0.93 0.01 230)" : "var(--paper-2)";
  return (
    <div style={{ position:"relative", background: bg, padding:56, display:"flex", flexDirection:"column", justifyContent:"space-between", borderLeft:"1px solid var(--rule)", overflow:"hidden", height:"100%" }}>
      <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:.07, pointerEvents:"none" }}>
        <defs><pattern id="dots-h" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--ink)"/></pattern></defs>
        <rect width="100%" height="100%" fill="url(#dots-h)"/>
      </svg>
      <div className="mono" style={{ fontSize:11, letterSpacing:".12em", color:"var(--muted)", position:"relative", visibility: showIssue ? "visible" : "hidden" }}>
        VOL. 01 · ISSUE 03 · EARLY ACCESS
      </div>
      <div style={{ position:"relative", maxWidth:480 }}>
        {treatment === "headline" && (
          <>
            <div style={{ marginBottom:24 }}><Mark size={64} colorN="var(--indigo)" colorS="var(--teal)"/></div>
            <h2 className="serif" style={{ fontSize:54, lineHeight:1.05, letterSpacing:"-0.025em", margin:0, fontWeight:500 }}>
              {headline.split(" ").slice(0, -3).join(" ")}{" "}
              <em style={{ color:"var(--indigo)" }}>{headline.split(" ").slice(-3).join(" ")}</em>
            </h2>
            <p style={{ fontSize:16, lineHeight:1.55, color:"#3a342c", margin:"24px 0 0", maxWidth:420 }}>
              Build a personal corpus of papers, run queries that respect provenance, and draft directly against your annotations.
            </p>
          </>
        )}
        {treatment === "pullquote" && (
          <>
            <div style={{ fontSize:80, lineHeight:.5, color:"var(--indigo)", fontFamily:"Source Serif 4, serif" }}>“</div>
            <h2 className="serif" style={{ fontSize:36, lineHeight:1.2, letterSpacing:"-0.015em", margin:"16px 0 0", fontWeight:500, fontStyle:"italic" }}>
              The closest thing to having a research assistant who actually read every paper in my library.
            </h2>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginTop:32 }}>
              <div style={{ width:40, height:40, borderRadius:20, background:"var(--indigo)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:600, fontSize:14 }}>SK</div>
              <div>
                <div style={{ fontSize:14, fontWeight:500 }}>Dr. Sara Kostas</div>
                <div style={{ fontSize:12, color:"var(--muted)" }}>Computational Biology · Stanford</div>
              </div>
            </div>
          </>
        )}
        {treatment === "mark" && (
          <div style={{ display:"flex", justifyContent:"center", alignItems:"center", height:"100%" }}>
            <Mark size={260} colorN="var(--indigo)" colorS="var(--teal)"/>
          </div>
        )}
      </div>
      {showStats ? (
        <div style={{ position:"relative", display:"flex", gap:32, fontSize:12, color:"var(--muted)" }}>
          <div><div style={{ fontSize:22, color:"var(--ink)", fontWeight:600, letterSpacing:"-0.02em" }}>1.4M</div><div className="mono" style={{ letterSpacing:".06em" }}>indexed papers</div></div>
          <div><div style={{ fontSize:22, color:"var(--ink)", fontWeight:600, letterSpacing:"-0.02em" }}>340</div><div className="mono" style={{ letterSpacing:".06em" }}>early researchers</div></div>
          <div><div style={{ fontSize:22, color:"var(--ink)", fontWeight:600, letterSpacing:"-0.02em" }}>v0.3</div><div className="mono" style={{ letterSpacing:".06em" }}>private beta</div></div>
        </div>
      ) : <div/>}
    </div>
  );
};

// ─────────── Form column (re-used by desktop + tablet) ───────────
const FormColumn = ({ mode = "signin", padding = "56px 72px" }) => {
  const c = COPY[mode];
  return (
    <div style={{ padding, display:"flex", flexDirection:"column", height:"100%" }}>
      <Lockup variant="split" size={20} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ flex:1 }}/>
      <div style={{ maxWidth:380, width:"100%", display:"flex", flexDirection:"column", gap:22 }}>
        <div>
          <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:8 }}>{c.eyebrow}</div>
          <h1 className="serif" style={{ fontSize:38, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>{c.h1}</h1>
          <p style={{ fontSize:14, color:"var(--muted)", margin:"10px 0 0", lineHeight:1.55 }}>{c.sub}</p>
        </div>

        {mode === "waitlist" && (
          <>
            <Field label="Email"><input className="ns-input" placeholder="you@university.edu"/></Field>
            <Field label="Field of research" hint="So we can prioritize invites by topic"><input className="ns-input" placeholder="e.g. computational neuroscience"/></Field>
            <Field label="What would you do with notesci?" hint="A sentence is plenty"><textarea className="ns-input" rows={3} style={{ resize:"vertical", fontFamily:"inherit" }} placeholder="Reading group on transformer interpretability…"/></Field>
            <button className="ns-btn full">Add me to the waitlist</button>
          </>
        )}
        {mode === "signup" && (
          <>
            <Field label="Invite code" hint="✓ invite valid · case-insensitive">
              <input className="ns-input mono" defaultValue="NS-7K2X" style={{ letterSpacing:".15em", textTransform:"uppercase" }}/>
            </Field>
            <Field label="Email"><input className="ns-input" placeholder="you@university.edu"/></Field>
            <Field label="Password" hint="12+ characters"><input className="ns-input" type="password" placeholder="••••••••••••"/></Field>
            <button className="ns-btn full">Claim my account</button>
            <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center" }}>No invite? <a href="#" style={{ color:"var(--ink)" }}>Join the waitlist</a></div>
          </>
        )}
        {mode === "signin" && (
          <>
            <Field label="Email"><input className="ns-input" defaultValue="jin@brown.edu"/></Field>
            <Field label="Password" action={<a href="#" style={{ color:"var(--muted)" }}>Forgot?</a>}>
              <input className="ns-input" type="password" defaultValue="••••••••••••"/>
            </Field>
            <button className="ns-btn full">Sign in</button>
            <div className="divider">OR CONTINUE WITH</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <SocialBtn icon={ICON.google} label="Google"/>
              <SocialBtn icon={ICON.github} label="GitHub"/>
              <SocialBtn icon={ICON.orcid} label="ORCID"/>
              <SocialBtn icon={ICON.inst} label="Institution"/>
            </div>
            <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center" }}>New here with an invite? <a href="#" style={{ color:"var(--ink)" }}>Claim your account</a></div>
          </>
        )}
      </div>
      <div style={{ flex:1 }}/>
      <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".06em", display:"flex", gap:18 }}>
        <span>© 2026 notesci</span><span>privacy</span><span>terms</span>
      </div>
    </div>
  );
};

// ═══════════════ V1 — Desktop ═══════════════
const V1 = ({ width = 1440, height = 900, mode = "signin", hero = {} }) => (
  <div style={{ width, height, display:"grid", gridTemplateColumns:"1fr 1fr", background:"var(--paper)" }}>
    <FormColumn mode={mode}/>
    <Hero {...hero}/>
  </div>
);

// ═══════════════ V1 — Tablet (834×1112) ═══════════════
const V1Tablet = ({ mode = "signin", hero = {} }) => (
  <div style={{ width:834, height:1112, display:"grid", gridTemplateRows:"360px 1fr", background:"var(--paper)" }}>
    <div style={{ height:360, overflow:"hidden" }}>
      <Hero {...hero}/>
    </div>
    <FormColumn mode={mode} padding="40px 56px"/>
  </div>
);

// ═══════════════ V1 — Mobile (390×844) ═══════════════
const V1Mobile = ({ mode = "signin" }) => {
  const c = COPY[mode];
  return (
    <div style={{ width:390, height:844, background:"var(--paper)", padding:"32px 28px", display:"flex", flexDirection:"column", gap:18, overflow:"hidden" }}>
      <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
      <div style={{ marginTop:8 }}>
        <div className="mono" style={{ fontSize:11, letterSpacing:".1em", color:"var(--muted)", marginBottom:6 }}>{c.eyebrow}</div>
        <h1 className="serif" style={{ fontSize:30, lineHeight:1.1, letterSpacing:"-0.02em", margin:0, fontWeight:500 }}>{c.h1}</h1>
        <p style={{ fontSize:13, color:"var(--muted)", margin:"8px 0 0", lineHeight:1.5 }}>{c.sub}</p>
      </div>
      {mode === "signin" && (
        <>
          <Field label="Email"><input className="ns-input" defaultValue="jin@brown.edu"/></Field>
          <Field label="Password" action={<a href="#" style={{ color:"var(--muted)" }}>Forgot?</a>}>
            <input className="ns-input" type="password" defaultValue="••••••••••••"/>
          </Field>
          <button className="ns-btn full">Sign in</button>
          <div className="divider">OR</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <SocialBtn icon={ICON.google} label="Google"/>
            <SocialBtn icon={ICON.github} label="GitHub"/>
            <SocialBtn icon={ICON.orcid} label="ORCID"/>
            <SocialBtn icon={ICON.inst} label="Institution"/>
          </div>
          <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center", marginTop:"auto" }}>
            Got an invite? <a href="#" style={{ color:"var(--ink)" }}>Claim your account</a>
          </div>
        </>
      )}
      {mode === "signup" && (
        <>
          <Field label="Invite code" hint="✓ invite valid"><input className="ns-input mono" defaultValue="NS-7K2X" style={{ letterSpacing:".15em", textTransform:"uppercase" }}/></Field>
          <Field label="Email"><input className="ns-input" placeholder="you@university.edu"/></Field>
          <Field label="Password" hint="12+ characters"><input className="ns-input" type="password" placeholder="••••••••••••"/></Field>
          <button className="ns-btn full">Claim my account</button>
          <div style={{ fontSize:12, color:"var(--muted)", textAlign:"center", marginTop:"auto" }}>No invite? <a href="#" style={{ color:"var(--ink)" }}>Join the waitlist</a></div>
        </>
      )}
      {mode === "waitlist" && (
        <>
          <Field label="Email"><input className="ns-input" placeholder="you@university.edu"/></Field>
          <Field label="Field"><input className="ns-input" placeholder="computational neuroscience"/></Field>
          <Field label="What would you do with notesci?"><textarea className="ns-input" rows={3} style={{ resize:"vertical", fontFamily:"inherit" }} placeholder="…"/></Field>
          <button className="ns-btn full">Add me to the waitlist</button>
        </>
      )}
    </div>
  );
};

// Expose to flows.jsx + app.jsx
Object.assign(window, { V1, V1Tablet, V1Mobile, Hero, FormColumn, Field, SocialBtn, ICON, COPY, TWEAK_DEFAULTS });
