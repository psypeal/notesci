// gen-app.jsx — top-level: lays artboards out on a design canvas.

const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window;
const { GenLanding } = window;
const { GenChat } = window;
const { GenChatWithPromote } = window;

function App() {
  return (
    <DesignCanvas
      title="notesci · general chat"
      subtitle="ChatGPT-style entry surface · default screen on login · projects are one click away"
      initialZoom={0.42}>

      <DCSection id="landing" title="01 · Landing · the default screen on login">
        <DCArtboard id="landing" label="Empty · editorial title + composer + starters + recent" width={1440} height={900}>
          <GenLanding/>
        </DCArtboard>
        <DCPostIt top={20} right={-30} rotate={3} width={210}>
          First screen on login. Composer is the point — surrounded by starter chips, recent threads, and a quiet "when to use a project" card.
        </DCPostIt>
      </DCSection>

      <DCSection id="active" title="02 · Active conversation · session in progress">
        <DCArtboard id="active" label="Active · serif messages + quote blocks" width={1440} height={900}>
          <GenChat/>
        </DCArtboard>
        <DCArtboard id="active-web" label="Web search on · composer toggle active" width={1440} height={900}>
          <GenChat webOn={true} composerText="What did Hu et al. propose in the original LoRA paper?"/>
        </DCArtboard>
        <DCArtboard id="active-attach" label="Ad-hoc PDF attached · single-session use" width={1440} height={900}>
          <GenChat composerText="Summarize this for me — short."
            attachments={[{ name:"hu-2021-lora.pdf", size:"1.2 MB", kind:"pdf" }]}/>
        </DCArtboard>
        <DCArtboard id="active-collapsed" label="Sidebar collapsed · focus mode" width={1440} height={900}>
          <GenChat sidebar="collapsed"/>
        </DCArtboard>
      </DCSection>

      <DCSection id="promote" title="03 · Promote to project · banner + modal">
        <DCArtboard id="banner" label="Smart banner · appears after ~3 messages" width={1440} height={900}>
          <GenChat showPromote={true}/>
        </DCArtboard>
        <DCArtboard id="modal" label="Promote modal · pick what carries over" width={1440} height={900}>
          <GenChatWithPromote/>
        </DCArtboard>
        <DCPostIt top={20} right={-30} rotate={-3} width={220}>
          Two surfaces: a quiet banner in the thread when notesci thinks you're "in a project", and the top-bar "Save as project" button always available.
        </DCPostIt>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
