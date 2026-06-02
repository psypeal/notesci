// db-pages.jsx — most dashboard pages (excluding MCP marketplace/installed which live in db-mcp.jsx).
const { Icons, ME, MEMBERS, SOURCES, API_KEYS, WEBHOOKS, AUDIT, LIBRARY } = window;
const { PageHeader } = window;

// ─────────── shared bits ───────────
const Field = ({ label, hint, children, span = 1 }) => (
  <label style={{ display:"flex", flexDirection:"column", gap:6, gridColumn:`span ${span}` }}>
    <span className="mono" style={{ fontSize:10.5, letterSpacing:".08em", color:"var(--muted)", textTransform:"uppercase" }}>{label}</span>
    {children}
    {hint && <span style={{ fontSize:11.5, color:"var(--muted)" }}>{hint}</span>}
  </label>
);
const Toggle = ({ on = false }) => (
  <span style={{ width:34, height:20, borderRadius:10, background: on ? "var(--ink)" : "var(--rule-2)", padding:2, display:"inline-flex", flexShrink:0 }}>
    <span style={{ width:16, height:16, borderRadius:8, background:"#fff", marginLeft: on ? 14 : 0, transition:"margin .15s" }}/>
  </span>
);
const SectionCard = ({ title, sub, children, action }) => (
  <div className="card" style={{ marginBottom:18 }}>
    <div style={{ padding:"16px 22px", borderBottom:"1px solid var(--rule)", display:"flex", alignItems:"center", gap:14 }}>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:14, fontWeight:500 }}>{title}</div>
        {sub && <div style={{ fontSize:12.5, color:"var(--muted)", marginTop:2 }}>{sub}</div>}
      </div>
      {action}
    </div>
    {children}
  </div>
);

// ─────────── Beta panel (shown across many pages) ───────────
const BetaPanel = () => (
  <div className="pane" style={{ background:"var(--paper-2)", marginBottom:18, padding:"14px 18px", display:"flex", alignItems:"center", gap:14 }}>
    <div style={{ width:36, height:36, borderRadius:18, background:"var(--warn-soft)", color:"var(--warn)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
      <Icons.sparkles size={16}/>
    </div>
    <div style={{ flex:1 }}>
      <div style={{ fontSize:13.5, fontWeight:500 }}>You're on the closed beta · no billing yet</div>
      <div style={{ fontSize:12.5, color:"var(--muted)", marginTop:1 }}>
        Your invite code: <span className="mono" style={{ color:"var(--ink-2)" }}>NS-7K2P-49QR</span> · 3 of 3 invites remaining
      </div>
    </div>
    <button className="ns-btn ghost tiny">Invite a friend</button>
  </div>
);

// ─────────── Profile ───────────
const ProfilePage = () => (
  <>
    <PageHeader eyebrow="GENERAL · PROFILE"
      title="How notesci sees you."
      desc="Name, photo, and what shows up in shared sessions and team headers."/>
    <BetaPanel/>
    <SectionCard title="Identity" sub="Visible to anyone you collaborate with.">
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"120px 1fr", gap:24, alignItems:"flex-start" }}>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
          <div style={{ width:96, height:96, borderRadius:48, background:"var(--indigo)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:34, fontWeight:600 }}>{ME.avatar}</div>
          <button className="ns-btn ghost tiny">Upload photo</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          <Field label="Display name"><input className="ns-input" defaultValue={ME.name}/></Field>
          <Field label="Pronouns"><input className="ns-input" defaultValue="they/them"/></Field>
          <Field label="Email" hint="Used for sign-in and notifications."><input className="ns-input" defaultValue={ME.email}/></Field>
          <Field label="Role / title"><input className="ns-input" defaultValue={ME.role}/></Field>
          <Field label="Bio" span={2} hint="Shown on shared session headers."><textarea className="ns-input" rows={3} defaultValue="Cog sci postdoc working on working memory & LM benchmarks."/></Field>
        </div>
      </div>
      <div style={{ padding:"14px 22px", borderTop:"1px solid var(--rule)", display:"flex", justifyContent:"flex-end", gap:8 }}>
        <button className="ns-btn ghost tiny">Cancel</button>
        <button className="ns-btn">Save changes</button>
      </div>
    </SectionCard>
    <SectionCard title="Linked identities" sub="Used for sign-in, never posted on your behalf.">
      {[
        { name:"Google", email:"jin@stanford.edu", linked:true },
        { name:"GitHub", email:"@jinpark",        linked:true },
        { name:"ORCID",  email:"0000-0002-…",     linked:false },
      ].map(p => (
        <div key={p.name} className="lrow">
          <div style={{ width:32, height:32, borderRadius:16, background:"var(--paper-2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:600, color:"var(--ink-2)" }}>{p.name[0]}</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:500 }}>{p.name}</div>
            <div className="mono" style={{ fontSize:11, color:"var(--muted)" }}>{p.email}</div>
          </div>
          <button className="ns-btn ghost tiny">{p.linked ? "Unlink" : "Connect"}</button>
        </div>
      ))}
    </SectionCard>
  </>
);

// ─────────── Preferences ───────────
const PreferencesPage = () => (
  <>
    <PageHeader eyebrow="GENERAL · PREFERENCES"
      title="Make notesci feel like yours."
      desc="Defaults that the workspace, graph, and chat will reach for unless you change them in the moment."/>
    <SectionCard title="Appearance">
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr", gap:18 }}>
        <Field label="Theme">
          <div style={{ display:"flex", gap:8 }}>
            {[["paper","Paper",true],["light","Light"],["dark","Dark"],["system","System"]].map(([id,label,on]) => (
              <button key={id} className={`ns-btn tiny ${on ? "" : "ghost"}`} style={{ flex:1 }}>{label}</button>
            ))}
          </div>
        </Field>
        <Field label="Density">
          <div style={{ display:"flex", gap:8 }}>
            {[["comfortable","Comfortable",true],["compact","Compact"]].map(([id,label,on]) => (
              <button key={id} className={`ns-btn tiny ${on ? "" : "ghost"}`} style={{ flex:1 }}>{label}</button>
            ))}
          </div>
        </Field>
      </div>
    </SectionCard>
    <SectionCard title="Workspace defaults">
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr", gap:18 }}>
        <Field label="Default layout"      hint="What opens when you click into a project.">
          <select className="ns-input"><option>Default · 3-pane</option><option>Reading</option><option>Drafting</option></select>
        </Field>
        <Field label="Default graph mode"  hint="Citations is best for surveys; Concepts for new collections.">
          <select className="ns-input"><option>Citations</option><option>Concepts</option><option>Reasoning trail</option></select>
        </Field>
        <Field label="Default model"       hint="Thorough is slower but cites more carefully.">
          <select className="ns-input"><option>Thorough</option><option>Fast</option></select>
        </Field>
        <Field label="Auto-save drafts">
          <div style={{ display:"flex", alignItems:"center", gap:10, paddingTop:6 }}><Toggle on/> <span style={{ fontSize:13 }}>Every 8 seconds</span></div>
        </Field>
      </div>
    </SectionCard>
    <SectionCard title="Keyboard shortcuts" sub="Press ⌘K anywhere to open the command palette." action={<button className="ns-btn ghost tiny">Customize</button>}>
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 24px" }}>
        {[
          ["New session","⌘N"],["Switch project","⌘⇧P"],["Command palette","⌘K"],
          ["Toggle Tweaks","⌘."],["Open graph","⌘G"],["Cite at cursor","⌘⇧C"],
        ].map(([k,v]) => (
          <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:13 }}>
            <span style={{ color:"var(--ink-2)" }}>{k}</span>
            <span className="mono" style={{ color:"var(--muted)" }}>{v}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  </>
);

// ─────────── Notifications ───────────
const NotificationsPage = () => (
  <>
    <PageHeader eyebrow="GENERAL · NOTIFICATIONS"
      title="When notesci should reach out."
      desc="Email is the only channel during the beta. We'll add Slack, in-product, and digests later."/>
    <SectionCard title="Email">
      {[
        ["Mentions in shared sessions",        "Anytime someone @-mentions you.", true],
        ["New material indexed",               "When a connected source finishes importing.", true],
        ["Long-running session finished",      "When a multi-source session you started completes.", true],
        ["Weekly digest",                      "Mondays · what your team explored last week.", false],
        ["MCP failures or rate limits",        "If a connected MCP needs reauth or hits a quota.", true],
        ["Product announcements",              "New features, beta milestones.", false],
      ].map(([t,d,on]) => (
        <div key={t} className="lrow">
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:500 }}>{t}</div>
            <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>{d}</div>
          </div>
          <Toggle on={on}/>
        </div>
      ))}
    </SectionCard>
  </>
);

// ─────────── Privacy ───────────
const PrivacyPage = () => (
  <>
    <PageHeader eyebrow="GENERAL · PRIVACY & DATA"
      title="Your sources are yours."
      desc="notesci grounds answers in your materials. Below is exactly what we keep, what we don't, and how to take it all with you."/>
    <SectionCard title="Training">
      <div className="lrow">
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:500 }}>Help improve notesci with my chats and sources</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>Off by default. Even when on, your raw materials are never used to train models.</div>
        </div>
        <Toggle on={false}/>
      </div>
      <div className="lrow">
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:500 }}>Allow third-party model providers to log my prompts</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>Required if you bring your own OpenAI/Anthropic key without their privacy add-ons.</div>
        </div>
        <Toggle on={false}/>
      </div>
    </SectionCard>
    <SectionCard title="Your data">
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14 }}>
        {[
          ["Sources","23 PDFs · 6 notes · 4 web clips","Stored encrypted at rest"],
          ["Sessions","6 sessions · 87 messages","30-day soft-delete after removal"],
          ["Indexed embeddings","~1.8M vectors","Regenerated whenever you re-index"],
        ].map(([t,a,b]) => (
          <div key={t} style={{ padding:"14px 16px", border:"1px solid var(--rule)", borderRadius:10, background:"var(--paper-2)" }}>
            <div className="mono" style={{ fontSize:10.5, letterSpacing:".08em", color:"var(--muted)" }}>{t.toUpperCase()}</div>
            <div style={{ fontSize:14, fontWeight:500, marginTop:4 }}>{a}</div>
            <div style={{ fontSize:11.5, color:"var(--muted)", marginTop:2 }}>{b}</div>
          </div>
        ))}
      </div>
      <div style={{ padding:"14px 22px", borderTop:"1px solid var(--rule)", display:"flex", gap:8 }}>
        <button className="ns-btn ghost tiny">Export everything (.zip)</button>
        <button className="ns-btn ghost tiny">Re-index all materials</button>
        <button className="ns-btn danger tiny" style={{ marginLeft:"auto" }}>Delete account</button>
      </div>
    </SectionCard>
    <SectionCard title="Personal access token" sub="Optional · for power users who want to script exports. Most people will never need this.">
      <div className="lrow">
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:500 }}>No token created</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>Read-only access to your own projects, sessions, and exports. One token per account.</div>
        </div>
        <button className="ns-btn ghost tiny">Create token</button>
      </div>
    </SectionCard>
  </>
);

// ─────────── Members (admin) ───────────
const ROLE_COLORS = { Owner:"indigo", Admin:"teal", Member:"", Viewer:"warn" };
const MembersPage = () => (
  <>
    <PageHeader eyebrow="WORKSPACE · MEMBERS"
      title="Who's in Park Lab."
      desc="Invite collaborators, change roles, and see pending invitations. Only admins can change roles."
      action={<button className="ns-btn"><Icons.plus size={12}/> Invite member</button>}/>
    <SectionCard title={`${MEMBERS.length} members · 1 pending`} sub="Seat usage: 6 of 25 in your beta workspace."
      action={<input className="ns-input" placeholder="Filter members…" style={{ width:220 }}/>}>
      {MEMBERS.map(m => (
        <div key={m.email} className="lrow">
          <div className="avatar" style={{ background: m.status === "pending" ? "var(--rule-2)" : "var(--indigo)" }}>{m.initials}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, fontWeight:500 }}>
              {m.name}
              {m.status === "pending" && <span className="tag warn" style={{ fontSize:10 }}>PENDING</span>}
            </div>
            <div className="mono" style={{ fontSize:11, color:"var(--muted)", marginTop:1 }}>{m.email}</div>
          </div>
          <span className="mono" style={{ fontSize:11, color:"var(--muted)" }}>{m.joined}</span>
          <span className={`tag ${ROLE_COLORS[m.role] || ""}`}>{m.role}</span>
          <button className="ns-btn ghost tiny" style={{ padding:"4px 6px" }}><Icons.kebab size={12}/></button>
        </div>
      ))}
    </SectionCard>
  </>
);

// ─────────── Roles ───────────
const RolesPage = () => {
  const ROLES = ["Owner","Admin","Member","Viewer"];
  const PERMS = [
    ["Manage billing & workspace settings",   [true,false,false,false]],
    ["Invite & remove members",                [true,true, false,false]],
    ["Install MCP servers",                    [true,true, false,false]],
    ["Connect data sources",                   [true,true, true, false]],
    ["Create projects & sessions",             [true,true, true, false]],
    ["Edit materials",                         [true,true, true, false]],
    ["View shared projects",                   [true,true, true, true ]],
    ["Comment in sessions",                    [true,true, true, true ]],
  ];
  return (
    <>
      <PageHeader eyebrow="WORKSPACE · ROLES"
        title="What each role can do."
        desc="During the beta, roles are fixed. Custom roles arrive with the team plan."/>
      <SectionCard title="Permission matrix">
        <div style={{ overflow:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr style={{ background:"var(--paper-2)" }}>
                <th style={{ textAlign:"left", padding:"12px 18px", fontWeight:500, fontSize:12, color:"var(--muted)" }}>PERMISSION</th>
                {ROLES.map(r => <th key={r} style={{ padding:"12px 14px", fontWeight:500, fontSize:12, color:"var(--muted)" }}>{r}</th>)}
              </tr>
            </thead>
            <tbody>
              {PERMS.map(([p, allowed]) => (
                <tr key={p} style={{ borderTop:"1px solid var(--rule)" }}>
                  <td style={{ padding:"12px 18px", color:"var(--ink-2)" }}>{p}</td>
                  {allowed.map((y,i) => (
                    <td key={i} style={{ padding:"12px 14px", textAlign:"center", color: y ? "var(--good)" : "var(--muted-2)" }}>
                      {y ? "●" : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
};

// ─────────── SSO ───────────
const SSOPage = () => (
  <>
    <PageHeader eyebrow="WORKSPACE · SSO"
      title="Sign-in for your team."
      desc="SAML SSO and SCIM provisioning land with the Team plan post-beta. Below is what we're building toward."/>
    <SectionCard title="SAML 2.0">
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <Field label="Identity provider"><select className="ns-input" disabled><option>Okta · pre-configured</option></select></Field>
        <Field label="Domain"><input className="ns-input" defaultValue="stanford.edu" disabled/></Field>
        <Field label="ACS URL" span={2}><input className="ns-input mono" defaultValue="https://notesci.app/sso/acs/parklab" disabled/></Field>
      </div>
      <div style={{ padding:"14px 22px", borderTop:"1px solid var(--rule)", display:"flex", gap:8 }}>
        <span className="tag warn">COMING POST-BETA</span>
        <button className="ns-btn ghost tiny" style={{ marginLeft:"auto" }} disabled>Test connection</button>
      </div>
    </SectionCard>
  </>
);

// ─────────── Audit log ───────────
const AuditPage = () => (
  <>
    <PageHeader eyebrow="WORKSPACE · AUDIT LOG"
      title="Everything that happened, recorded."
      desc="Workspace-level events, kept for 90 days during the beta and exportable as CSV."/>
    <SectionCard title="Recent activity"
      action={<div style={{ display:"flex", gap:8 }}>
        <input className="ns-input" placeholder="Filter…" style={{ width:200 }}/>
        <button className="ns-btn ghost tiny">Export CSV</button>
      </div>}>
      {AUDIT.map((a, i) => (
        <div key={i} className="lrow">
          <div className="avatar" style={{ background:"var(--paper-2)", color:"var(--ink-2)" }}>{a.who.split(" ").map(s=>s[0]).join("")}</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13 }}>
              <span style={{ fontWeight:500 }}>{a.who}</span>{" "}
              <span style={{ color:"var(--muted)" }}>{a.what}</span>{" "}
              <span style={{ color:"var(--ink)" }}>{a.target}</span>
            </div>
            <div className="mono" style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{a.at}</div>
          </div>
          <button className="ns-btn ghost tiny">View →</button>
        </div>
      ))}
    </SectionCard>
  </>
);

// ─────────── Sources ───────────
const SourceLogo = ({ s, size = 40 }) => (
  <div style={{ width:size, height:size, borderRadius:8, background:s.color, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.42, fontWeight:600, flexShrink:0 }}>{s.name[0]}</div>
);
const SourcesPage = () => (
  <>
    <PageHeader eyebrow="CONNECTIONS · SOURCES"
      title="Pipe materials in from where they live."
      desc="Sources push documents into your project library on a schedule. Different from MCPs — sources are read-only data feeds."
      action={<button className="ns-btn ghost"><Icons.plus size={12}/> Add custom source</button>}/>
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      {SOURCES.map(s => (
        <div key={s.id} className="card" style={{ padding:18, display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <SourceLogo s={s}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>{s.name}</div>
              <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>{s.desc}</div>
            </div>
            {s.connected
              ? <span className="tag good">CONNECTED</span>
              : <span className="tag" style={{ color:"var(--muted)" }}>NOT CONNECTED</span>}
          </div>
          {s.connected && (
            <div style={{ borderTop:"1px solid var(--rule)", paddingTop:12, display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ flex:1 }}>
                <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".08em" }}>{s.account}</div>
                <div style={{ fontSize:11.5, color:"var(--muted)", marginTop:1 }}>{s.last}</div>
              </div>
              <button className="ns-btn ghost tiny">Settings</button>
              <button className="ns-btn ghost tiny">Sync now</button>
            </div>
          )}
          {!s.connected && (
            <div style={{ borderTop:"1px solid var(--rule)", paddingTop:12 }}>
              <button className="ns-btn tiny">Connect →</button>
            </div>
          )}
        </div>
      ))}
    </div>
  </>
);

// ─────────── Citations & Export ───────────
const CITATION_STYLES = [
  ["apa",       "APA 7th",      "Park, J. (2025). Working memory benchmarks…"],
  ["chicago",   "Chicago",      "Park, Jin. \"Working memory benchmarks…\" 2025."],
  ["vancouver", "Vancouver",    "Park J. Working memory benchmarks. 2025;14(3):221-238."],
  ["mla",       "MLA 9th",      "Park, Jin. \"Working memory benchmarks…\" 2025."],
];
const CitationsPage = () => (
  <>
    <PageHeader eyebrow="RESEARCH · CITATIONS & EXPORT"
      title="How notesci formats your work."
      desc="Pick the citation style your field uses. Every quote, draft, and export will follow it — no manual reformatting."/>
    <SectionCard title="Default citation style" sub="Applied to in-chat citations and all exports.">
      <div style={{ padding:"6px 0" }}>
        {CITATION_STYLES.map(([id, label, sample], i) => (
          <label key={id} className="lrow" style={{ cursor:"pointer", borderTop: i ? "1px solid var(--rule)" : "none" }}>
            <input type="radio" name="cite" defaultChecked={id === "apa"} style={{ accentColor:"var(--ink)", marginRight:4 }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13.5, fontWeight:500 }}>{label}</div>
              <div className="serif" style={{ fontSize:12.5, color:"var(--muted)", marginTop:2, fontStyle:"italic" }}>{sample}</div>
            </div>
          </label>
        ))}
      </div>
    </SectionCard>
    <SectionCard title="Export defaults" sub="What goes in each format when you export a session or draft.">
      <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        {[
          ["Markdown (.md)",   "Inline citations + bibliography at end"],
          ["Word (.docx)",     "Footnotes, bibliography, your style"],
          ["BibTeX (.bib)",    "Just the references — for LaTeX projects"],
          ["PDF",              "Print-ready, with cover page"],
        ].map(([t, d]) => (
          <div key={t} style={{ padding:"14px 16px", border:"1px solid var(--rule)", borderRadius:10, background:"var(--paper-2)", display:"flex", alignItems:"flex-start", gap:12 }}>
            <Icons.download size={16} style={{ color:"var(--ink-2)", marginTop:2 }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:500 }}>{t}</div>
              <div style={{ fontSize:11.5, color:"var(--muted)", marginTop:2 }}>{d}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="lrow">
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:500 }}>Include DOIs and PMIDs whenever available</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>Recommended — keeps citations machine-resolvable.</div>
        </div>
        <Toggle on={true}/>
      </div>
      <div className="lrow">
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:500 }}>Group bibliography by source type</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:1 }}>Journal articles, books, web sources — separately.</div>
        </div>
        <Toggle on={false}/>
      </div>
    </SectionCard>
    <SectionCard title="Export current project" sub="One-click bundle of every session, draft, and material.">
      <div style={{ padding:22, display:"flex", gap:8, flexWrap:"wrap" }}>
        <button className="ns-btn"><Icons.download size={12}/> Export as .docx</button>
        <button className="ns-btn ghost"><Icons.download size={12}/> Export as .md</button>
        <button className="ns-btn ghost"><Icons.download size={12}/> Export bibliography (.bib)</button>
        <button className="ns-btn ghost"><Icons.download size={12}/> Export everything (.zip)</button>
      </div>
    </SectionCard>
  </>
);

// ─────────── Reproducibility (coming soon) ───────────
const ReproducibilityPage = () => (
  <>
    <PageHeader eyebrow="RESEARCH · REPRODUCIBILITY"
      title="Pin your work to a moment in time."
      desc="So a paper you cite next year still resolves to the same answer."/>
    <div className="card" style={{ padding:32, background:"var(--paper)", textAlign:"center" }}>
      <div className="mono" style={{ fontSize:11, color:"var(--warn)", letterSpacing:".12em", marginBottom:10 }}>COMING AFTER BETA</div>
      <div className="serif" style={{ fontSize:24, fontWeight:500, lineHeight:1.2, letterSpacing:"-0.02em", marginBottom:12, maxWidth:540, margin:"0 auto 12px" }}>
        Freeze a session as a citable snapshot.
      </div>
      <div style={{ fontSize:13.5, color:"var(--ink-2)", lineHeight:1.55, maxWidth:560, margin:"0 auto 20px" }}>
        Pin specific model versions per project. Generate a content-addressed snapshot of every source and message in a session. Mint a DOI through DataCite — so reviewers can run the same query a year from now and get the same answer.
      </div>
      <div style={{ display:"flex", gap:8, justifyContent:"center" }}>
        <button className="ns-btn">Notify me when this ships</button>
        <button className="ns-btn ghost">Read the design doc →</button>
      </div>
    </div>
  </>
);

// ─────────── Webhooks (DEPRECATED — kept for compat, no longer routed) ───────────
const WebhooksPage = () => (
  <>
    <PageHeader eyebrow="DEVELOPER · WEBHOOKS"
      title="Push events outward."
      desc="notesci will POST signed JSON to your endpoints when interesting things happen — sessions complete, materials are added, MCPs change state."
      action={<button className="ns-btn"><Icons.plus size={12}/> Add webhook</button>}/>
    <SectionCard title="Endpoints">
      {WEBHOOKS.map(w => (
        <div key={w.id} className="lrow" style={{ alignItems:"flex-start" }}>
          <div style={{ width:32, height:32, borderRadius:8, background:"var(--paper-2)", color:"var(--ink-2)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <Icons.send size={14}/>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div className="mono" style={{ fontSize:12.5, color:"var(--ink)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{w.url}</div>
            <div style={{ display:"flex", gap:6, marginTop:6, flexWrap:"wrap" }}>
              {w.events.map(e => <span key={e} className="tag" style={{ fontSize:10 }}>{e}</span>)}
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <span className={`tag ${w.status === "healthy" ? "good" : "error"}`}>{w.status === "healthy" ? "HEALTHY" : "FAILING"}</span>
            <div className="mono" style={{ fontSize:11, color:"var(--muted)", marginTop:4 }}>{w.deliveries}</div>
          </div>
          <button className="ns-btn ghost tiny">Test</button>
          <button className="ns-btn ghost tiny" style={{ padding:"4px 6px" }}><Icons.kebab size={12}/></button>
        </div>
      ))}
    </SectionCard>
  </>
);

// ─────────── Library ───────────
const LibraryPage = () => (
  <>
    <PageHeader eyebrow="LIBRARY · ALL PROJECTS"
      title="Everything in one searchable place."
      desc="Cross-project search across projects, sessions, and materials. Filter by kind or tag, jump straight in."/>
    <div style={{ display:"flex", gap:10, marginBottom:16 }}>
      <div style={{ position:"relative", flex:1 }}>
        <input className="ns-input" placeholder="Search across all projects…" style={{ paddingLeft:34 }}/>
        <span style={{ position:"absolute", left:12, top:9, color:"var(--muted)" }}><Icons.search size={14}/></span>
      </div>
      <div style={{ display:"flex", padding:3, background:"#fff", borderRadius:8, border:"1px solid var(--rule-2)" }}>
        {[["all","All",true],["project","Projects"],["session","Sessions"],["material","Materials"]].map(([id,label,on]) => (
          <button key={id} className={`ns-btn tiny ${on ? "" : "ghost"}`} style={{ borderColor: on ? "var(--ink)" : "transparent" }}>{label}</button>
        ))}
      </div>
    </div>
    <SectionCard title={`${LIBRARY.length} results · sorted by recency`}>
      {LIBRARY.map((r,i) => {
        const I = r.kind === "project" ? Icons.folder : r.kind === "session" ? Icons.bot : Icons.pdf;
        return (
          <div key={i} className="lrow">
            <div style={{ width:32, height:32, borderRadius:8, background:"var(--paper-2)", color:"var(--ink-2)", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <I size={14}/>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.name}</div>
              <div className="mono" style={{ fontSize:11, color:"var(--muted)", marginTop:1 }}>{r.kind.toUpperCase()} · {r.meta}</div>
            </div>
            <div className="mono" style={{ fontSize:11, color:"var(--muted)" }}>{r.at}</div>
            <button className="ns-btn ghost tiny">Open</button>
          </div>
        );
      })}
    </SectionCard>
  </>
);

Object.assign(window, { ProfilePage, PreferencesPage, NotificationsPage, PrivacyPage, MembersPage, RolesPage, SSOPage, AuditPage, SourcesPage, CitationsPage, ReproducibilityPage, APIKeysPage, WebhooksPage, LibraryPage, BetaPanel, SectionCard, Field, Toggle, SourceLogo });
