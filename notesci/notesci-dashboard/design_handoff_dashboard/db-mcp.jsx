// db-mcp.jsx — MCP marketplace, server detail, installed page, install flow.
const { Icons, MCP_CATS, MCP_SERVERS } = window;
const { PageHeader, SectionCard, Toggle, Field } = window;

// Tile color from server id (deterministic)
const tileColor = (id) => {
  const palette = ["#1e3a8a","#0f766e","#9d174d","#b45309","#4338ca","#065f46","#7c2d12","#0369a1","#5b21b6","#9f1239"];
  let h = 0; for (const c of id) h = (h*31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
};
const MCPTile = ({ s, size = 44 }) => (
  <div style={{ width:size, height:size, borderRadius:9, background:tileColor(s.id), color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.42, fontWeight:600, flexShrink:0, fontFamily:'"JetBrains Mono", monospace', letterSpacing:"-.04em" }}>{s.name.split(" ").map(w=>w[0]).slice(0,2).join("")}</div>
);

const StatusTag = ({ status }) => {
  if (status === "healthy") return <span className="tag good">HEALTHY</span>;
  if (status === "limited") return <span className="tag warn">RATE-LIMITED</span>;
  if (status === "reauth")  return <span className="tag error">NEEDS REAUTH</span>;
  return <span className="tag">UNKNOWN</span>;
};

// ─────────── Marketplace ───────────
const MCPCard = ({ s }) => (
  <div className="card" style={{ padding:16, display:"flex", flexDirection:"column", gap:12 }}>
    <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
      <MCPTile s={s}/>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:13.5, fontWeight:500 }}>{s.name}</span>
          {s.official && <span title="Official" style={{ color:"var(--indigo)" }}>✓</span>}
        </div>
        <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", marginTop:1 }}>by {s.author} · {s.cat}</div>
      </div>
      {s.installed && <span className="tag good" style={{ fontSize:10 }}>INSTALLED</span>}
    </div>
    <div style={{ fontSize:12.5, color:"var(--ink-2)", lineHeight:1.45, minHeight:54 }}>{s.desc}</div>
    <div style={{ display:"flex", alignItems:"center", gap:10, paddingTop:8, borderTop:"1px solid var(--rule)" }}>
      <span className="mono" style={{ fontSize:11, color:"var(--muted)" }}>★ {s.rating}</span>
      <span className="mono" style={{ fontSize:11, color:"var(--muted)" }}>{s.installs} installs</span>
      <button className={`ns-btn tiny ${s.installed ? "ghost" : ""}`} style={{ marginLeft:"auto" }}>
        {s.installed ? "Configure" : "Install"}
      </button>
    </div>
  </div>
);

const MCPMarketPage = ({ activeCat = "Featured" }) => {
  const featured = MCP_SERVERS.filter(s => s.featured);
  const byCat    = activeCat === "Featured" ? MCP_SERVERS : MCP_SERVERS.filter(s => s.cat === activeCat);
  return (
    <>
      <PageHeader eyebrow="CONNECTIONS · MCP MARKETPLACE"
        title="Tools the agent can reach for."
        desc="MCP (Model Context Protocol) servers extend notesci with new abilities — search PubMed, query a Jupyter kernel, post to Slack. Browse, install, and grant scopes per server."
        action={
          <div style={{ display:"flex", gap:8 }}>
            <button className="ns-btn ghost tiny">Submit a server</button>
            <button className="ns-btn tiny"><Icons.plus size={12}/> Install from URL</button>
          </div>
        }/>

      {/* Search + cats */}
      <div style={{ display:"flex", gap:10, marginBottom:14, alignItems:"center" }}>
        <div style={{ position:"relative", flex:1 }}>
          <input className="ns-input" placeholder="Search 218 MCP servers…" style={{ paddingLeft:34 }}/>
          <span style={{ position:"absolute", left:12, top:9, color:"var(--muted)" }}><Icons.search size={14}/></span>
        </div>
        <button className="ns-btn ghost tiny"><Icons.filter size={12}/> Sort: Popular</button>
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:18, overflow:"auto" }}>
        {MCP_CATS.map(c => (
          <span key={c} className={`tag ${c === activeCat ? "solid" : ""}`} style={{ padding:"5px 11px", fontSize:11.5, cursor:"pointer", flexShrink:0 }}>{c}</span>
        ))}
      </div>

      {/* Featured strip (only on Featured) */}
      {activeCat === "Featured" && (
        <>
          <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:10 }}>FEATURED THIS WEEK</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:24 }}>
            {featured.slice(0,2).map(s => (
              <div key={s.id} className="card" style={{ padding:18, display:"flex", gap:14, background:"var(--paper)", borderColor:"var(--rule-2)" }}>
                <MCPTile s={s} size={56}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:15, fontWeight:500 }}>{s.name}</span>
                    {s.official && <span className="tag indigo" style={{ fontSize:10 }}>OFFICIAL</span>}
                  </div>
                  <div className="serif" style={{ fontSize:13.5, color:"var(--ink-2)", marginTop:4, lineHeight:1.45 }}>{s.desc}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:12, marginTop:10 }}>
                    <span className="mono" style={{ fontSize:11, color:"var(--muted)" }}>★ {s.rating} · {s.installs} installs</span>
                    <button className={`ns-btn tiny ${s.installed ? "ghost" : ""}`} style={{ marginLeft:"auto" }}>{s.installed ? "Configure" : "Install"}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:10 }}>{activeCat.toUpperCase()} · {byCat.length} SERVERS</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14 }}>
        {byCat.map(s => <MCPCard key={s.id} s={s}/>)}
      </div>
    </>
  );
};

// ─────────── MCP detail (modal-style on top of marketplace) ───────────
const MCPDetailPage = () => {
  const s = MCP_SERVERS.find(x => x.id === "pubmed");
  return (
    <>
      <PageHeader eyebrow={`CONNECTIONS · MCP · ${s.cat.toUpperCase()}`}
        title={s.name}
        desc={s.desc}
        action={<button className="ns-btn">Install · grant scopes</button>}/>
      <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:18 }}>
        <div>
          <SectionCard title="What this server can do">
            <div style={{ padding:18 }}>
              {[
                ["search_pubmed",       "Free-text + MeSH search across PubMed."],
                ["fetch_article",       "Fetch abstract, authors, and DOI by PMID."],
                ["clinical_trials",     "Look up registered trials by condition/intervention."],
                ["citation_neighbors",  "Find papers that co-cite a given PMID."],
              ].map(([fn, d]) => (
                <div key={fn} style={{ display:"flex", gap:14, padding:"10px 0", borderTop:"1px solid var(--rule)" }}>
                  <span className="mono" style={{ fontSize:12, color:"var(--indigo)", minWidth:170 }}>{fn}()</span>
                  <span style={{ fontSize:13, color:"var(--ink-2)" }}>{d}</span>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Required scopes" sub="What this server is allowed to do in your workspace.">
            {[
              ["Read project materials",    "Needed to ground searches in your existing sources.", true],
              ["Append search results",     "Save retrieved abstracts as new materials.",          true],
              ["Network · pubmed.ncbi.nlm.nih.gov", "Outbound HTTPS to NCBI's API.",              true],
              ["Read your name & email",    "Optional · attribution on saved materials.",          false],
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
          <SectionCard title="Reviews · 1.2k">
            {[
              { who:"Ramesh L.", at:"3d ago", stars:5, body:"Replaced four bookmarks I used to keep open. The MeSH search is dramatically better than the web UI." },
              { who:"Aiko T.",   at:"1w ago", stars:4, body:"Solid. Wish it could surface preprint mirrors when an article is paywalled." },
            ].map((r,i) => (
              <div key={i} className="lrow" style={{ alignItems:"flex-start" }}>
                <div className="avatar">{r.who[0]}</div>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:13, fontWeight:500 }}>{r.who}</span>
                    <span className="mono" style={{ fontSize:11, color:"var(--muted)" }}>{"★".repeat(r.stars)}{"☆".repeat(5-r.stars)} · {r.at}</span>
                  </div>
                  <div style={{ fontSize:13, color:"var(--ink-2)", marginTop:4, lineHeight:1.5 }}>{r.body}</div>
                </div>
              </div>
            ))}
          </SectionCard>
        </div>
        <aside>
          <div className="card" style={{ padding:18, marginBottom:14 }}>
            <MCPTile s={s} size={64}/>
            <div style={{ marginTop:14, display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, fontSize:12.5 }}>
              {[
                ["Author",   s.author],
                ["Category", s.cat],
                ["Rating",   `★ ${s.rating}`],
                ["Installs", s.installs],
                ["Version",  "1.4.2"],
                ["Updated",  "Apr 28"],
              ].map(([k,v]) => (
                <div key={k}>
                  <div className="mono" style={{ fontSize:10, color:"var(--muted)", letterSpacing:".08em" }}>{k.toUpperCase()}</div>
                  <div style={{ marginTop:2, color:"var(--ink-2)" }}>{v}</div>
                </div>
              ))}
            </div>
            <button className="ns-btn" style={{ width:"100%", marginTop:14 }}>Install · grant scopes</button>
            <button className="ns-btn ghost tiny" style={{ width:"100%", marginTop:6 }}>View source on GitHub →</button>
          </div>
          <div className="card" style={{ padding:18 }}>
            <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".08em", marginBottom:10 }}>SAFETY</div>
            <div style={{ fontSize:12.5, color:"var(--ink-2)", lineHeight:1.5 }}>
              Reviewed by the notesci team on Apr 12. No known credential leaks. Sandboxed network egress. <a href="#" style={{ color:"var(--indigo)" }}>Read full review →</a>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
};

// ─────────── Installed MCPs ───────────
const MCPInstalledPage = () => {
  const installed = MCP_SERVERS.filter(s => s.installed);
  return (
    <>
      <PageHeader eyebrow="CONNECTIONS · INSTALLED MCPS"
        title="Tools your agent can use right now."
        desc="Per-server config, scopes, and call logs. Disable a server temporarily without uninstalling."
        action={<button className="ns-btn ghost tiny"><Icons.plus size={12}/> Browse marketplace</button>}/>
      <SectionCard title={`${installed.length} servers installed`} sub="Health checks run every 5 minutes.">
        {installed.map(s => (
          <div key={s.id} className="lrow" style={{ alignItems:"flex-start" }}>
            <MCPTile s={s} size={36}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:13.5, fontWeight:500 }}>{s.name}</span>
                {s.official && <span className="tag indigo" style={{ fontSize:10 }}>OFFICIAL</span>}
              </div>
              <div className="mono" style={{ fontSize:11, color:"var(--muted)", marginTop:1 }}>by {s.author} · 4 functions · 247 calls this month</div>
            </div>
            <StatusTag status={s.status}/>
            <Toggle on={s.status !== "reauth"}/>
            <button className="ns-btn ghost tiny">Configure</button>
            <button className="ns-btn ghost tiny" style={{ padding:"4px 6px" }}><Icons.kebab size={12}/></button>
          </div>
        ))}
      </SectionCard>

      {/* Detail drawer for one of them, expanded inline */}
      <SectionCard title="W&B · per-server detail" sub="Currently selected. Click another row to switch.">
        <div style={{ padding:22, display:"grid", gridTemplateColumns:"1fr 1fr", gap:18 }}>
          <Field label="Account" hint="Authenticated as">
            <input className="ns-input" defaultValue="jin@stanford.edu · org parklab"/>
          </Field>
          <Field label="Default project">
            <select className="ns-input"><option>parklab/wm-transformer</option><option>parklab/rlhf-survey</option></select>
          </Field>
          <Field label="Granted scopes" span={2}>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              <span className="tag good">read:runs</span>
              <span className="tag good">read:artifacts</span>
              <span className="tag warn">write:runs (denied)</span>
              <span className="tag" style={{ borderStyle:"dashed", color:"var(--muted)" }}>+ request more</span>
            </div>
          </Field>
        </div>
        <div style={{ borderTop:"1px solid var(--rule)", padding:"14px 22px" }}>
          <div className="mono" style={{ fontSize:10.5, letterSpacing:".08em", color:"var(--muted)", marginBottom:8 }}>RECENT CALLS</div>
          <div style={{ fontSize:12, fontFamily:'"JetBrains Mono",monospace', color:"var(--ink-2)", lineHeight:1.7 }}>
            <div><span style={{ color:"var(--good)" }}>200</span> <span style={{ color:"var(--muted)" }}>10:14:02</span> wandb.list_runs(project=wm-transformer) → 47 results</div>
            <div><span style={{ color:"var(--good)" }}>200</span> <span style={{ color:"var(--muted)" }}>10:13:55</span> wandb.get_run(id=4f29) → 1.2 KB</div>
            <div><span style={{ color:"var(--warn)" }}>429</span> <span style={{ color:"var(--muted)" }}>10:08:12</span> wandb.list_artifacts(...) → rate limited (retry in 14s)</div>
            <div><span style={{ color:"var(--good)" }}>200</span> <span style={{ color:"var(--muted)" }}>10:07:30</span> wandb.list_runs(project=rlhf-survey) → 11 results</div>
          </div>
        </div>
        <div style={{ borderTop:"1px solid var(--rule)", padding:"14px 22px", display:"flex", justifyContent:"space-between", gap:8 }}>
          <button className="ns-btn ghost tiny">View all logs →</button>
          <div style={{ display:"flex", gap:8 }}>
            <button className="ns-btn ghost tiny">Reauthenticate</button>
            <button className="ns-btn ghost tiny" style={{ color:"var(--error)" }}>Uninstall</button>
          </div>
        </div>
      </SectionCard>
    </>
  );
};

// ─────────── Install confirmation modal (overlaid on marketplace) ───────────
const InstallModal = () => {
  const s = MCP_SERVERS.find(x => x.id === "pubmed");
  return (
    <div style={{ position:"absolute", inset:0, background:"rgba(14,17,22,.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:5 }}>
      <div className="card" style={{ width:480, padding:24, background:"var(--paper)" }}>
        <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:18 }}>
          <MCPTile s={s} size={56}/>
          <div style={{ flex:1 }}>
            <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", letterSpacing:".08em" }}>INSTALL · MCP SERVER</div>
            <div style={{ fontSize:18, fontWeight:500, marginTop:2 }}>{s.name}</div>
            <div style={{ fontSize:12.5, color:"var(--muted)" }}>by {s.author} · v1.4.2 · ★ {s.rating}</div>
          </div>
        </div>
        <div className="serif" style={{ fontSize:13.5, color:"var(--ink-2)", lineHeight:1.55, marginBottom:14 }}>
          {s.name} is asking for the following access in your workspace:
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:18 }}>
          {[
            ["Read project materials",   "to ground searches"],
            ["Append search results",    "as new materials"],
            ["Network · NCBI",           "outbound HTTPS"],
          ].map(([t,d]) => (
            <div key={t} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 12px", border:"1px solid var(--rule)", borderRadius:8, background:"#fff" }}>
              <span style={{ color:"var(--good)", marginTop:2 }}>●</span>
              <div>
                <div style={{ fontSize:13, fontWeight:500 }}>{t}</div>
                <div style={{ fontSize:11.5, color:"var(--muted)" }}>{d}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize:11.5, color:"var(--muted)", marginBottom:18, lineHeight:1.5 }}>
          You can revoke any of these at any time from <span className="mono">Connections › Installed MCPs</span>. Reviewed by the notesci team on Apr 12.
        </div>
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          <button className="ns-btn ghost">Cancel</button>
          <button className="ns-btn">Install · grant scopes</button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { MCPMarketPage, MCPDetailPage, MCPInstalledPage, InstallModal, MCPTile });
