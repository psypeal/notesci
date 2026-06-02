// db-app.jsx — top-level: lays artboards out on a design canvas.
const { DesignCanvas, DCSection, DCArtboard } = window;
const { PageScaffold, DBTopBar, DBRail, DBFrame } = window;
const {
  ProfilePage, PreferencesPage, NotificationsPage, PrivacyPage,
  MembersPage, RolesPage, SSOPage, AuditPage,
  SourcesPage, CitationsPage, ReproducibilityPage, LibraryPage,
} = window;
const { MCPMarketPage, MCPDetailPage, MCPInstalledPage, InstallModal } = window;
const { TweaksPanel, TweakSection, TweakRadio, useTweaks } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "role": "admin",
  "mcpDensity": "many",
  "theme": "paper"
}/*EDITMODE-END*/;

// Empty-state for marketplace (used as a tweak)
const MCPMarketEmpty = () => (
  <DBFrame>
    <DBTopBar crumbs={["Settings","Connections","MCP marketplace"]}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
      <DBRail active="mcp-market"/>
      <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:60, textAlign:"center" }}>
        <div style={{ maxWidth:440 }}>
          <div className="mono" style={{ fontSize:10.5, letterSpacing:".12em", color:"var(--muted)", marginBottom:8 }}>NO MCPS INSTALLED</div>
          <div className="serif" style={{ fontSize:28, fontWeight:500, lineHeight:1.15, letterSpacing:"-0.02em", marginBottom:10 }}>Give the agent some hands.</div>
          <div style={{ fontSize:14, color:"var(--ink-2)", lineHeight:1.55, marginBottom:18 }}>
            Out of the box, notesci grounds answers in your sources. Install MCP servers to let it search beyond — PubMed, GitHub, your Jupyter kernel, and more.
          </div>
          <button className="ns-btn">Browse 218 servers →</button>
        </div>
      </div>
    </div>
  </DBFrame>
);

// MCP detail with install modal overlaid
const MCPMarketWithModal = () => (
  <DBFrame>
    <DBTopBar crumbs={["Settings","Connections","MCP marketplace","PubMed"]}/>
    <div style={{ flex:1, display:"flex", overflow:"hidden", position:"relative" }}>
      <DBRail active="mcp-market"/>
      <div style={{ flex:1, overflow:"auto", padding:"28px 36px", maxWidth:1100, margin:"0 auto", width:"100%", filter:"blur(2px)", opacity:.7 }}>
        <MCPDetailPage/>
      </div>
      <InstallModal/>
    </div>
  </DBFrame>
);

function App() {
  const [t, setT] = useTweaks(TWEAK_DEFAULTS);

  return (
    <>
      <DesignCanvas title="notesci · dashboard"
        subtitle="Settings, members, MCP marketplace, library — invite-only beta · no billing"
        initialZoom={0.42}>

        <DCSection id="mcp-primary" title="01 · Connections · MCP marketplace · the centerpiece of this beta">
          <DCArtboard id="mcp-market" label="MCP marketplace · browse" width={1440} height={1100}>
            <PageScaffold active="mcp-market" crumbs={["Settings","Connections","MCP marketplace"]}>
              <MCPMarketPage activeCat="Featured"/>
            </PageScaffold>
          </DCArtboard>
          <DCArtboard id="mcp-detail" label="MCP detail · scopes, functions, reviews" width={1440} height={1100}>
            <PageScaffold active="mcp-market" crumbs={["Settings","Connections","MCP marketplace","PubMed"]}>
              <MCPDetailPage/>
            </PageScaffold>
          </DCArtboard>
          <DCArtboard id="mcp-install" label="MCP install confirm · scope grant modal" width={1440} height={1100}>
            <MCPMarketWithModal/>
          </DCArtboard>
          <DCArtboard id="mcp-installed" label="Installed MCPs · per-server config + logs" width={1440} height={1100}>
            <PageScaffold active="mcp-installed" crumbs={["Settings","Connections","Installed MCPs"]}>
              <MCPInstalledPage/>
            </PageScaffold>
          </DCArtboard>
        </DCSection>

        <DCSection id="general" title="02 · General · personal settings">
          <DCArtboard id="profile" label="Profile" width={1440} height={1100}>
            <PageScaffold active="profile" crumbs={["Settings","Profile"]}><ProfilePage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="preferences" label="Preferences" width={1440} height={1100}>
            <PageScaffold active="preferences" crumbs={["Settings","Preferences"]}><PreferencesPage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="notifications" label="Notifications" width={1440} height={1100}>
            <PageScaffold active="notifications" crumbs={["Settings","Notifications"]}><NotificationsPage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="privacy" label="Privacy & data" width={1440} height={1100}>
            <PageScaffold active="privacy" crumbs={["Settings","Privacy & data"]}><PrivacyPage/></PageScaffold>
          </DCArtboard>
        </DCSection>

        <DCSection id="workspace" title="03 · Workspace · admin views">
          <DCArtboard id="members" label="Members & invites" width={1440} height={1100}>
            <PageScaffold active="members" crumbs={["Settings","Workspace","Members"]}><MembersPage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="roles" label="Roles · permission matrix" width={1440} height={1100}>
            <PageScaffold active="roles" crumbs={["Settings","Workspace","Roles"]}><RolesPage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="sso" label="SSO · post-beta" width={1440} height={1100}>
            <PageScaffold active="sso" crumbs={["Settings","Workspace","SSO"]}><SSOPage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="audit" label="Audit log" width={1440} height={1100}>
            <PageScaffold active="audit" crumbs={["Settings","Workspace","Audit log"]}><AuditPage/></PageScaffold>
          </DCArtboard>
        </DCSection>

        <DCSection id="connections" title="04 · Connections · data sources (separate from MCPs)">
          <DCArtboard id="sources" label="Sources · Zotero, Notion, Drive, etc" width={1440} height={1100}>
            <PageScaffold active="sources" crumbs={["Settings","Connections","Sources"]}><SourcesPage/></PageScaffold>
          </DCArtboard>
        </DCSection>

        <DCSection id="research" title="05 · Research · citations & reproducibility (replaces dev tools)">
          <DCArtboard id="citations" label="Citations & export · style + bundles" width={1440} height={1100}>
            <PageScaffold active="citations" crumbs={["Settings","Research","Citations & export"]}><CitationsPage/></PageScaffold>
          </DCArtboard>
          <DCArtboard id="reproducibility" label="Reproducibility · coming soon" width={1440} height={1100}>
            <PageScaffold active="reproducibility" crumbs={["Settings","Research","Reproducibility"]}><ReproducibilityPage/></PageScaffold>
          </DCArtboard>
        </DCSection>

        <DCSection id="library" title="06 · Library · cross-project search">
          <DCArtboard id="library" label="All projects · sessions · materials" width={1440} height={1100}>
            <PageScaffold active="library" crumbs={["Settings","Library"]}><LibraryPage/></PageScaffold>
          </DCArtboard>
        </DCSection>

        <DCSection id="empty" title="07 · Non-happy paths">
          <DCArtboard id="empty-mcp" label="No MCPs installed yet" width={1440} height={1100}>
            <MCPMarketEmpty/>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Persona">
          <TweakRadio t={t} setT={setT} k="role" label="Viewer role"
            options={[["member","Member"],["admin","Admin"],["dev","Developer"]]}/>
        </TweakSection>
        <TweakSection title="MCP density">
          <TweakRadio t={t} setT={setT} k="mcpDensity" label="Marketplace"
            options={[["empty","None"],["few","Few"],["many","Many"]]}/>
        </TweakSection>
        <TweakSection title="Theme">
          <TweakRadio t={t} setT={setT} k="theme" label="Surface"
            options={[["paper","Paper"],["white","Plain"]]}/>
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
