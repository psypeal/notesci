// app.jsx — lays out logo concepts on the design canvas

const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window;

// Small helper: artboard with header tag + footer caption
const LogoArtboard = ({ id, label, width = 360, height = 360, tag, color = "var(--indigo)", colorName = "indigo", children, foot }) => (
  <DCArtboard id={id} label={label} width={width} height={height}>
    <div className="ab">
      <div className="grid-bg" />
      <div className="corner-tag">{tag}</div>
      <div className="corner-meta">SVG · scalable</div>
      <div className="ab-stage">{children}</div>
      <div className="ab-foot">
        <span><span className="dot" style={{ background: color }} />{colorName}</span>
        <span>{foot}</span>
      </div>
    </div>
  </DCArtboard>
);

// In-context: app header preview
const HeaderPreview = ({ Mark, color, accent }) => (
  <div style={{ width:"100%", height:"100%", background:"#fff", display:"flex", flexDirection:"column" }}>
    <div style={{ display:"flex", alignItems:"center", padding:"14px 20px", borderBottom:"1px solid var(--rule)", gap: 14 }}>
      <Mark size={28} color={color} color2={accent} />
      <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em" }}>
        note<span style={{ color: "var(--muted)", fontWeight: 500 }}>sci</span>
      </div>
      <div style={{ flex:1 }} />
      <div className="mono" style={{ fontSize: 11, color: "var(--muted)", letterSpacing:".05em" }}>
        Library · Drafts · Search
      </div>
    </div>
    <div style={{ padding:"18px 20px", display:"flex", flexDirection:"column", gap: 10 }}>
      <div className="mono" style={{ fontSize:10, color:"var(--muted)", letterSpacing:".08em" }}>RECENT QUERIES</div>
      {["spike-timing dependent plasticity in cortex", "CRISPR Cas13 off-target review (2024–25)", "graph neural networks for molecular property"].map((q, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px dashed var(--rule)" }}>
          <div style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
          <div style={{ fontSize: 13, color: "var(--ink)" }}>{q}</div>
          <div style={{ flex:1 }} />
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>↩</div>
        </div>
      ))}
    </div>
  </div>
);

// In-context: favicon strip
const FaviconStrip = ({ Mark, color, accent }) => (
  <div style={{ display:"flex", flexDirection:"column", gap: 18, alignItems:"center" }}>
    {[16, 24, 32, 48, 64].map(sz => (
      <div key={sz} style={{ display:"flex", alignItems:"center", gap: 16 }}>
        <div className="mono" style={{ width: 28, fontSize: 11, color: "var(--muted)", textAlign:"right" }}>{sz}px</div>
        <div style={{ width: sz, height: sz, display:"flex", alignItems:"center", justifyContent:"center", background:"#fff", border:"1px solid var(--rule)", borderRadius: 4 }}>
          <Mark size={sz - 4} color={color} color2={accent} />
        </div>
      </div>
    ))}
  </div>
);

const App = () => (
  <DesignCanvas>
    {/* ───────── Notes ───────── */}
    <DCSection id="brief" title="Brief & system" subtitle="The thinking before the marks">
      <DCArtboard id="brief-card" label="Direction" width={420} height={420}>
        <div className="ab note" style={{ padding: 28, display:"flex", flexDirection:"column", gap:0 }}>
          <div className="mono" style={{ fontSize: 10, letterSpacing:".1em", color:"var(--muted)", marginBottom: 14 }}>NOTESCI · LOGO BRIEF</div>
          <h2>Modern, geometric, friendly.</h2>
          <p>Lettermark (N or NS monogram). The metaphor is a <b>knowledge graph</b> — notes as nodes, citations as edges.</p>
          <h2 style={{ marginTop: 14 }}>Type</h2>
          <p>Inter Tight, lowercase wordmark. The <span className="mono">sci</span> sits in muted weight to let <span className="mono">note</span> lead.</p>
          <h2 style={{ marginTop: 14 }}>Color</h2>
          <p>Vibrant but disciplined: indigo, teal, violet — same chroma, varying hue.</p>
          <div className="swatches" style={{ marginTop: 4 }}>
            <div className="sw" style={{ background:"var(--indigo)" }} />
            <div className="sw" style={{ background:"var(--teal)" }} />
            <div className="sw" style={{ background:"var(--violet)" }} />
            <div className="sw" style={{ background:"var(--ink)" }} />
            <div className="sw" style={{ background:"var(--paper)", border:"1px solid var(--rule)" }} />
          </div>
        </div>
      </DCArtboard>
      <DCPostIt top={20} right={-40} rotate={3}>Eight directions, ordered roughly safe → expressive. Mix freely — e.g. mark from 02 with lockup style of 05.</DCPostIt>
    </DCSection>

    {/* ───────── Marks ───────── */}
    <DCSection id="marks" title="Lettermarks" subtitle="Eight directions on the N / NS monogram">
      <LogoArtboard id="m1" label="01 · Apex nodes" tag="01" color="var(--indigo)" colorName="indigo">
        <Hero Mark={Logo01} color="var(--indigo)" />
      </LogoArtboard>

      <LogoArtboard id="m2" label="02 · Lattice diagonal" tag="02" color="var(--indigo)" colorName="indigo" foot="N as graph diagonal">
        <Hero Mark={Logo02} color="var(--indigo)" />
      </LogoArtboard>

      <LogoArtboard id="m3" label="03 · NS converge" tag="03" color="var(--teal)" colorName="teal + indigo" foot="two-color monogram">
        <Hero Mark={Logo03} color="var(--teal)" accent="var(--indigo)" />
      </LogoArtboard>

      <LogoArtboard id="m4" label="04 · Hex cell" tag="04" color="var(--violet)" colorName="violet" foot="structural / molecular">
        <Hero Mark={Logo04} color="var(--violet)" />
      </LogoArtboard>

      <LogoArtboard id="m5" label="05 · Soft tile" tag="05" color="var(--indigo)" colorName="indigo→teal" foot="app-icon ready">
        <Hero Mark={(p) => <Logo05 {...p} idSuffix="hero" />} color="white" />
      </LogoArtboard>

      <LogoArtboard id="m6" label="06 · Constellation" tag="06" color="var(--indigo)" colorName="indigo" foot="airy, scientific">
        <Hero Mark={Logo06} color="var(--indigo)" />
      </LogoArtboard>

      <LogoArtboard id="m7" label="07 · NS ligature tile" tag="07" color="var(--ink)" colorName="ink + teal" foot="favicon-friendly">
        <Hero Mark={Logo07} color="var(--ink)" />
      </LogoArtboard>

      <LogoArtboard id="m8" label="08 · Highlighted N" tag="08" color="var(--violet)" colorName="violet + lime" foot="annotation gesture">
        <Hero Mark={Logo08} color="var(--violet)" />
      </LogoArtboard>
    </DCSection>

    {/* ───────── Lockups ───────── */}
    <DCSection id="lockups" title="Wordmark lockups" subtitle="Mark + wordmark, horizontal">
      {[
        { id: "l1", label: "01", Mark: Logo01, color: "var(--indigo)" },
        { id: "l2", label: "02", Mark: Logo02, color: "var(--indigo)" },
        { id: "l3", label: "03", Mark: Logo03, color: "var(--teal)", accent: "var(--indigo)" },
        { id: "l4", label: "04", Mark: Logo04, color: "var(--violet)" },
        { id: "l5", label: "05", Mark: (p) => <Logo05 {...p} idSuffix={"l5"} />, color: "white" },
        { id: "l6", label: "06", Mark: Logo06, color: "var(--indigo)" },
        { id: "l7", label: "07", Mark: Logo07, color: "var(--ink)" },
        { id: "l8", label: "08", Mark: Logo08, color: "var(--violet)" },
      ].map(({ id, label, Mark, color, accent }) => (
        <DCArtboard key={id} id={id} label={label} width={420} height={160}>
          <div className="ab" style={{ alignItems:"center", justifyContent:"center" }}>
            <div className="ab-stage" style={{ padding: 0 }}>
              <Lockup Mark={Mark} color={color} accent={accent} />
            </div>
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ───────── In context ───────── */}
    <DCSection id="context" title="In context" subtitle="App header & favicon scales for the strongest contenders">
      <DCArtboard id="ctx-02" label="02 · in app header" width={520} height={280}>
        <HeaderPreview Mark={Logo02} color="var(--indigo)" />
      </DCArtboard>
      <DCArtboard id="ctx-06" label="06 · in app header" width={520} height={280}>
        <HeaderPreview Mark={Logo06} color="var(--indigo)" />
      </DCArtboard>
      <DCArtboard id="ctx-05" label="05 · in app header" width={520} height={280}>
        <HeaderPreview Mark={(p) => <Logo05 {...p} idSuffix="ctx5" />} color="white" />
      </DCArtboard>

      <DCArtboard id="fav-02" label="02 · favicon scales" width={260} height={420}>
        <div className="ab" style={{ alignItems:"center", justifyContent:"center" }}>
          <div className="ab-stage">
            <FaviconStrip Mark={Logo02} color="var(--indigo)" />
          </div>
        </div>
      </DCArtboard>
      <DCArtboard id="fav-07" label="07 · favicon scales" width={260} height={420}>
        <div className="ab" style={{ alignItems:"center", justifyContent:"center" }}>
          <div className="ab-stage">
            <FaviconStrip Mark={Logo07} color="var(--ink)" />
          </div>
        </div>
      </DCArtboard>
      <DCArtboard id="fav-05" label="05 · favicon scales" width={260} height={420}>
        <div className="ab" style={{ alignItems:"center", justifyContent:"center" }}>
          <div className="ab-stage">
            <FaviconStrip Mark={(p) => <Logo05 {...p} idSuffix="ctx5fav" />} color="white" />
          </div>
        </div>
      </DCArtboard>
    </DCSection>

    {/* ───────── Mono variants ───────── */}
    <DCSection id="mono" title="Mono / inverse" subtitle="Stress-tests for one-color print and dark UI">
      {[
        { id: "mono1", label: "01 · ink", Mark: Logo01, color: "var(--ink)", bg: "var(--paper)" },
        { id: "mono2", label: "02 · ink", Mark: Logo02, color: "var(--ink)", bg: "var(--paper)" },
        { id: "mono3", label: "06 · ink", Mark: Logo06, color: "var(--ink)", bg: "var(--paper)" },
        { id: "mono4", label: "01 · paper", Mark: Logo01, color: "var(--paper)", bg: "var(--ink)" },
        { id: "mono5", label: "02 · paper", Mark: Logo02, color: "var(--paper)", bg: "var(--ink)" },
        { id: "mono6", label: "06 · paper", Mark: Logo06, color: "var(--paper)", bg: "var(--ink)" },
      ].map(({ id, label, Mark, color, bg }) => (
        <DCArtboard key={id} id={id} label={label} width={240} height={240}>
          <div className="ab" style={{ background: bg }}>
            <div className="ab-stage">
              <Mark size={130} color={color} />
            </div>
          </div>
        </DCArtboard>
      ))}
    </DCSection>
  </DesignCanvas>
);

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
