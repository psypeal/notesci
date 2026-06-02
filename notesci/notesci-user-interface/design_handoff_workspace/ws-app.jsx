// ws-app.jsx — top-level: lays artboards out on a design canvas.
const { DesignCanvas, DCSection, DCArtboard } = window;
const { ModeDefault, ModeReading, ModeDrafting } = window;
const { GraphSpotlight } = window;
const { EmptyMaterials, EmptySession, EmptyProjects } = window;
const { TweaksPanel, TweakSection, TweakRadio, TweakSelect, TweakToggle, useTweaks } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "graphMode": "citations",
  "density": "comfortable",
  "theme": "paper"
}/*EDITMODE-END*/;

function App() {
  const [t, setT] = useTweaks(TWEAK_DEFAULTS);
  const setMode = m => setT("graphMode", m);

  // Density compaction via CSS var on body
  React.useEffect(() => {
    document.body.style.setProperty("--row-pad", t.density === "compact" ? "4px" : "6px");
  }, [t.density]);

  return (
    <>
      <DesignCanvas title="notesci · workspace" subtitle="Five layout modes for a research-grounded chat product · grounded in the sign-in design system" initialZoom={0.42}>
        <DCSection id="primary" title="01 · Primary workspace · 3-pane default · layout switcher in the top bar">
          <DCArtboard id="default" label={`Default · graph in "${t.graphMode}" mode`} width={1440} height={900}>
            <ModeDefault graphMode={t.graphMode} setGraphMode={setMode} layout="default"/>
          </DCArtboard>
        </DCSection>

        <DCSection id="modes" title="02 · Layout modes · the user toggles between these from the top-bar segmented control">
          <DCArtboard id="reading" label="Reading · source + graph" width={1440} height={900}>
            <ModeReading graphMode={t.graphMode} layout="reading"/>
          </DCArtboard>
          <DCArtboard id="drafting" label="Drafting · doc + chat assist" width={1440} height={900}>
            <ModeDrafting layout="drafting"/>
          </DCArtboard>
        </DCSection>

        <DCSection id="graph" title="03 · Graph spotlight · same graph pane, three lenses · users toggle from the pill in the graph header">
          {[
            ["citations","Citations · who-cites-whom"],
            ["concepts","Concepts · extracted topics"],
            ["trail","Reasoning trail · agent steps"],
          ].map(([id,label]) => (
            <DCArtboard key={id} id={`graph-${id}`} label={label} width={1100} height={760}>
              <GraphSpotlight mode={id}/>
            </DCArtboard>
          ))}
        </DCSection>

        <DCSection id="empty" title="04 · Empty states">
          <DCArtboard id="empty-projects" label="No projects · first run" width={1440} height={900}>
            <EmptyProjects/>
          </DCArtboard>
          <DCArtboard id="empty-materials" label="Project · no sources yet" width={1440} height={900}>
            <EmptyMaterials/>
          </DCArtboard>
          <DCArtboard id="empty-session" label="New session · prompt suggestions" width={1440} height={900}>
            <EmptySession/>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Graph">
          <TweakRadio t={t} setT={setT} k="graphMode" label="Default mode"
            options={[["citations","Citations"],["unified","Unified"],["concepts","Concepts"],["trail","Reasoning"]]}/>
        </TweakSection>
        <TweakSection title="Density">
          <TweakRadio t={t} setT={setT} k="density" label="UI density"
            options={[["comfortable","Comfortable"],["compact","Compact"]]}/>
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
