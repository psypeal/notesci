// db-chrome.jsx — top bar, left rail, frame, page header pattern.
const { Mark } = window;
const { Icons } = window;
const { ME } = window;

const DBFrame = ({ children, w = 1440, h = 1100, label }) => (
  <div style={{ width:w, height:h, background:"var(--paper-3)", display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>
    {children}
    {label && <div className="mono" style={{ position:"absolute", left:14, bottom:8, fontSize:10, color:"var(--muted)", letterSpacing:".1em" }}>{label}</div>}
  </div>
);

const DBTopBar = ({ crumbs = ["Settings"] }) => (
  <div style={{ height:48, background:"#fff", borderBottom:"1px solid var(--rule)", display:"flex", alignItems:"center", padding:"0 14px", gap:14, fontSize:13, color:"var(--ink)" }}>
    <Mark size={26} colorN="var(--indigo)" colorS="var(--teal)"/>
    <div style={{ width:1, height:18, background:"var(--rule)", marginLeft:4 }}/>
    <a href="#" style={{ display:"inline-flex", alignItems:"center", gap:6, color:"var(--ink-2)", textDecoration:"none", fontSize:12.5 }}>
      <Icons.chevRight size={12} style={{ transform:"rotate(180deg)" }}/> Back to workspace
    </a>
    <div style={{ width:1, height:18, background:"var(--rule)" }}/>
    <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:13 }}>
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color:"var(--muted-2)" }}>/</span>}
          <span style={{ color: i === crumbs.length - 1 ? "var(--ink)" : "var(--muted)", fontWeight: i === crumbs.length - 1 ? 500 : 400 }}>{c}</span>
        </React.Fragment>
      ))}
    </div>
    <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10 }}>
      <span className="tag warn" style={{ fontSize:10.5 }}>BETA · invite only</span>
      <div style={{ width:28, height:28, borderRadius:14, background:"var(--indigo)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:600 }}>{ME.avatar}</div>
    </div>
  </div>
);

// Left rail nav. Sections + items. Highlights `active` (id of item).
const NAV = [
  { section:"GENERAL",     items:[
    { id:"profile",       label:"Profile",         icon:"user" },
    { id:"preferences",   label:"Preferences",     icon:"sparkles" },
    { id:"notifications", label:"Notifications",   icon:"send" },
    { id:"privacy",       label:"Privacy & data",  icon:"eye" },
  ]},
  { section:"WORKSPACE",   items:[
    { id:"members",       label:"Members",         icon:"user" },
    { id:"roles",         label:"Roles",           icon:"layers" },
    { id:"sso",           label:"SSO",             icon:"plug" },
    { id:"audit",         label:"Audit log",       icon:"doc" },
  ]},
  { section:"CONNECTIONS", items:[
    { id:"sources",       label:"Sources",         icon:"folder", badge:"3" },
    { id:"mcp-market",    label:"MCP marketplace", icon:"plug",   pill:"Browse" },
    { id:"mcp-installed", label:"Installed MCPs",  icon:"plug",   badge:"4" },
    { id:"models",        label:"Models & keys",   icon:"sparkles" },
  ]},
  { section:"RESEARCH",    items:[
    { id:"citations",     label:"Citations & export", icon:"book" },
    { id:"reproducibility", label:"Reproducibility",  icon:"sparkles", pill:"Soon" },
  ]},
  { section:"LIBRARY",     items:[
    { id:"library",       label:"All projects",    icon:"folder" },
  ]},
  { section:"HELP",        items:[
    { id:"shortcuts",     label:"Keyboard shortcuts", icon:"slash" },
    { id:"changelog",     label:"What's new",      icon:"sparkles" },
  ]},
];

const DBRail = ({ active = "profile" }) => (
  <div style={{ width:248, background:"var(--paper)", borderRight:"1px solid var(--rule)", height:"100%", overflowY:"auto", flexShrink:0 }}>
    {NAV.map(group => (
      <div key={group.section}>
        <div className="group-label">{group.section}</div>
        <div style={{ padding:"0 8px 6px" }}>
          {group.items.map(item => {
            const I = Icons[item.icon] || Icons.layers;
            const isActive = item.id === active;
            return (
              <div key={item.id} className={`row ${isActive ? "active" : ""}`} style={{ padding:"7px 10px", fontSize:13 }}>
                <I size={14}/>
                <span style={{ flex:1 }}>{item.label}</span>
                {item.badge && <span className="tag" style={{ fontSize:10, padding:"1px 6px" }}>{item.badge}</span>}
                {item.pill && <span className="tag indigo" style={{ fontSize:10, padding:"1px 6px" }}>{item.pill}</span>}
              </div>
            );
          })}
        </div>
      </div>
    ))}
    {/* user card at bottom */}
    <div style={{ position:"sticky", bottom:0, background:"var(--paper)", borderTop:"1px solid var(--rule)", padding:"12px 14px", display:"flex", alignItems:"center", gap:10 }}>
      <div className="avatar">{ME.avatar}</div>
      <div style={{ minWidth:0, flex:1 }}>
        <div style={{ fontSize:12.5, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{ME.name}</div>
        <div className="mono" style={{ fontSize:10.5, color:"var(--muted)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{ME.workspace}</div>
      </div>
      <Icons.kebab size={14}/>
    </div>
  </div>
);

const PageHeader = ({ eyebrow, title, desc, action }) => (
  <div className="intro" style={{ display:"flex", alignItems:"flex-start", gap:24, marginBottom:18 }}>
    <div style={{ flex:1 }}>
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="title">{title}</h1>
      <div className="desc">{desc}</div>
    </div>
    {action && <div style={{ flexShrink:0 }}>{action}</div>}
  </div>
);

const PageScaffold = ({ active, crumbs, children }) => (
  <DBFrame>
    <DBTopBar crumbs={crumbs}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
      <DBRail active={active}/>
      <div style={{ flex:1, overflow:"auto", padding:"28px 36px", maxWidth:1100, margin:"0 auto", width:"100%" }}>
        {children}
      </div>
    </div>
  </DBFrame>
);

Object.assign(window, { DBFrame, DBTopBar, DBRail, PageHeader, PageScaffold });
