// emails.jsx — invite / reset / verify email templates rendered as HTML
// frames so the dev can lift the markup directly. 600px is the standard
// email content width.

const { Mark, Lockup } = window;

// Email shell mimicking Gmail/Apple Mail chrome so designers can see the
// envelope. The dev only needs the inner card.
const Envelope = ({ from, subject, children, height = 900 }) => (
  <div style={{ width:1440, height, background:"#ebe8e1", padding:"36px 0", display:"flex", flexDirection:"column", alignItems:"center" }}>
    <div style={{ width:560, marginBottom:18, display:"flex", justifyContent:"space-between", color:"var(--muted)", fontSize:12 }}>
      <span>From: <strong style={{ color:"var(--ink)" }}>{from}</strong></span>
      <span>To: <strong style={{ color:"var(--ink)" }}>jin@brown.edu</strong></span>
    </div>
    <div style={{ width:560, marginBottom:24 }}>
      <div className="mono" style={{ fontSize:11, color:"var(--muted)", letterSpacing:".06em", marginBottom:4 }}>SUBJECT</div>
      <div className="serif" style={{ fontSize:22, fontWeight:500, letterSpacing:"-0.01em" }}>{subject}</div>
    </div>
    {children}
  </div>
);

const Btn = ({ children }) => (
  <a href="#" style={{ display:"inline-block", padding:"14px 22px", background:"var(--ink)", color:"var(--paper)", textDecoration:"none", borderRadius:10, fontWeight:500, fontSize:14 }}>{children}</a>
);

const EmailCard = ({ children }) => (
  <div style={{ width:560, background:"var(--paper)", border:"1px solid var(--rule)", borderRadius:14, padding:"40px 44px", color:"var(--ink)", fontFamily:"inherit", lineHeight:1.55 }}>
    {children}
  </div>
);

const Footer = () => (
  <div style={{ marginTop:32, paddingTop:20, borderTop:"1px solid var(--rule)", fontSize:11.5, color:"var(--muted)", lineHeight:1.6 }}>
    notesci · early access · v0.3<br/>
    You're receiving this because someone invited you, or you started a notesci account. <a href="#" style={{ color:"var(--muted)" }}>Unsubscribe</a>.
  </div>
);

// ─────────── Invite email ───────────
const EmailInvite = () => (
  <Envelope from="hello@notesci.com" subject="You're invited to notesci.">
    <EmailCard>
      <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
      <h1 className="serif" style={{ fontSize:30, lineHeight:1.15, letterSpacing:"-0.02em", margin:"24px 0 8px", fontWeight:500 }}>
        Hi Jin — a seat is reserved for you on <em style={{ color:"var(--indigo)" }}>notesci</em>.
      </h1>
      <p style={{ fontSize:14.5, color:"#3a342c", margin:"0 0 20px" }}>
        notesci is a small, private tool for researchers who want a single source of truth for the papers they read, the queries they run, and the drafts they write. We're in early access — invite-only.
      </p>
      <div style={{ display:"flex", alignItems:"center", gap:14, padding:"16px 18px", background:"var(--paper-2)", border:"1px solid var(--rule)", borderRadius:10, marginBottom:24 }}>
        <div className="mono" style={{ fontSize:18, letterSpacing:".22em", fontWeight:600 }}>NS-7K2X</div>
        <div style={{ flex:1 }}/>
        <span className="mono" style={{ fontSize:11, color:"var(--teal)", letterSpacing:".1em" }}>VALID FOR 14 DAYS</span>
      </div>
      <Btn>Claim your account</Btn>
      <p style={{ fontSize:13, color:"var(--muted)", marginTop:24 }}>
        Or paste this link into a browser:<br/>
        <a href="#" className="mono" style={{ color:"var(--ink)", fontSize:12, wordBreak:"break-all" }}>https://notesci.com/invite/jin?c=NS-7K2X</a>
      </p>
      <Footer/>
    </EmailCard>
  </Envelope>
);

// ─────────── Reset email ───────────
const EmailReset = () => (
  <Envelope from="security@notesci.com" subject="Reset your notesci password">
    <EmailCard>
      <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
      <h1 className="serif" style={{ fontSize:28, lineHeight:1.15, letterSpacing:"-0.02em", margin:"24px 0 8px", fontWeight:500 }}>
        Reset your password.
      </h1>
      <p style={{ fontSize:14.5, color:"#3a342c", margin:"0 0 20px" }}>
        Someone (hopefully you) asked to reset the password on the notesci account at <strong>jin@brown.edu</strong>. The link below is good for 30 minutes.
      </p>
      <Btn>Choose a new password</Btn>
      <p style={{ fontSize:13, color:"var(--muted)", marginTop:24 }}>
        Didn't ask for this? You can safely ignore this email — your password won't change.
      </p>
      <p style={{ fontSize:12, color:"var(--muted)", marginTop:14 }}>
        Request from <span className="mono">128.148.x.x</span> · Providence, RI · Apr 30, 9:14 AM ET
      </p>
      <Footer/>
    </EmailCard>
  </Envelope>
);

// ─────────── Verify email ───────────
const EmailVerify = () => (
  <Envelope from="hello@notesci.com" subject="Confirm your email for notesci">
    <EmailCard>
      <Lockup variant="split" size={18} colorN="var(--indigo)" colorS="var(--teal)"/>
      <h1 className="serif" style={{ fontSize:28, lineHeight:1.15, letterSpacing:"-0.02em", margin:"24px 0 8px", fontWeight:500 }}>
        One last thing — confirm your email.
      </h1>
      <p style={{ fontSize:14.5, color:"#3a342c", margin:"0 0 20px" }}>
        Welcome to notesci. Click below to verify <strong>jin@brown.edu</strong> and finish activating your account.
      </p>
      <Btn>Verify my email</Btn>
      <p style={{ fontSize:13, color:"var(--muted)", marginTop:24 }}>
        Link expires in 24 hours. If you didn't sign up, you can ignore this — no account will be created.
      </p>
      <Footer/>
    </EmailCard>
  </Envelope>
);

Object.assign(window, { EmailInvite, EmailReset, EmailVerify });
