// identity.jsx — refined notesci identity sheet (concept 03)
//
// IMPORTANT: DesignCanvas walks only direct DCArtboard children of each
// DCSection. Helper wrappers that return a DCArtboard get filtered out.
// So everything below uses small render-function helpers that emit
// <DCArtboard> as direct JSX children inside the section, NOT custom
// components.

const { DesignCanvas, DCSection, DCArtboard, DCPostIt } = window;
const { Mark, Wordmark, Lockup } = window;

const PAIRS = [
  { id: "ti", name: "Teal + indigo",   N: "var(--indigo)", S: "var(--teal)" },
  { id: "iv", name: "Indigo + violet", N: "var(--indigo)", S: "var(--violet)" },
  { id: "tv", name: "Teal + violet",   N: "var(--violet)", S: "var(--teal)" },
];

const Tag  = ({ children }) => <div className="corner-tag">{children}</div>;
const Foot = ({ left, right }) => (
  <div className="ab-foot"><span>{left}</span><span>{right}</span></div>
);

const TOKENS = [
  { name: "--ink",    val: "#0e1116",                desc: "primary text + hub node" },
  { name: "--paper",  val: "#f6f4ef",                desc: "warm canvas background" },
  { name: "--indigo", val: "oklch(0.52 0.22 274)",   desc: "N glyph · primary brand" },
  { name: "--teal",   val: "oklch(0.62 0.14 195)",   desc: "S glyph · secondary" },
  { name: "--violet", val: "oklch(0.55 0.22 305)",   desc: "alt accent" },
  { name: "--muted",  val: "rgba(14,17,22,.55)",     desc: "secondary text" },
  { name: "--rule",   val: "rgba(14,17,22,.12)",     desc: "dividers, hairlines" },
];

const App = () => (
  <DesignCanvas>
    {/* ─── Story / brief ─── */}
    <DCSection id="brief" title="The mark" subtitle="Refined concept 03 — N + S converging at a shared node">
      <DCArtboard id="brief" label="Story" width={460} height={420}>
        <div className="ab" style={{ padding: 28 }}>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".1em", color: "var(--muted)", marginBottom: 16 }}>NOTESCI · IDENTITY</div>
          <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", margin: "0 0 12px" }}>Two glyphs, one anchor.</h2>
          <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "#3a342c", margin: "0 0 12px" }}>
            The <b>N</b> and <b>S</b> share a single solid node where their strokes terminate.
            That node is the visual anchor — "notes" and "science" converging into a point of knowledge.
          </p>
          <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "#3a342c", margin: "0 0 12px" }}>
            End-of-stroke joints are <b>open rings</b>; only the shared hub is solid. This reads as a graph and survives at favicon scale.
          </p>
          <p className="mono" style={{ fontSize: 11, color: "var(--muted)", margin: "16px 0 0" }}>
            Icon and wordmark are decoupled — use the icon as the project logo, and the wordmark on the site.
          </p>
        </div>
      </DCArtboard>
      <DCPostIt top={20} right={-30} rotate={3} width={200}>
        Three color pairings side-by-side. Pick one and I'll lock it as the canonical mark.
      </DCPostIt>
    </DCSection>

    {/* ─── Color pairings (hero cards) ─── */}
    <DCSection id="pairings" title="Color pairings" subtitle="Same mark, three palettes">
      {PAIRS.map(p => (
        <DCArtboard key={p.id} id={`hero-${p.id}`} label={p.name} width={420} height={420}>
          <div className="ab">
            <div className="grid-bg" />
            <Tag>{p.id.toUpperCase()} · ICON</Tag>
            <div className="ab-stage">
              <Mark size={220} colorN={p.N} colorS={p.S} />
            </div>
            <Foot left={p.name} right="96 × 96 svg" />
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ─── Wordmark variants ─── */}
    <DCSection id="wordmark" title="Wordmark" subtitle="Three weight treatments — independent of the icon">
      {[
        { v: "split",   label: "split (note + sci muted)" },
        { v: "accent",  label: "accent (sci in teal)" },
        { v: "uniform", label: "uniform (one weight)" },
      ].map(({ v, label }) => (
        <DCArtboard key={v} id={`wm-${v}`} label={label} width={420} height={180}>
          <div className="ab">
            <Tag>WORDMARK · {v.toUpperCase()}</Tag>
            <div className="ab-stage">
              <Wordmark variant={v} size={56} />
            </div>
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ─── Lockups ─── */}
    <DCSection id="lockups" title="Lockups" subtitle="Icon + wordmark together">
      {PAIRS.map(p => (
        <DCArtboard key={p.id} id={`lk-${p.id}`} label={p.name} width={460} height={180}>
          <div className="ab">
            <div className="ab-stage">
              <Lockup variant="split" size={40} colorN={p.N} colorS={p.S} />
            </div>
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ─── Favicon scales ─── */}
    <DCSection id="favicon" title="Favicon scales" subtitle="Stress test: 16 / 24 / 32 / 48 px">
      {PAIRS.map(p => (
        <DCArtboard key={p.id} id={`fav-${p.id}`} label={`Favicon · ${p.name}`} width={300} height={300}>
          <div className="ab">
            <Tag>FAVICON</Tag>
            <div className="ab-stage">
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {[16, 24, 32, 48].map(sz => (
                  <div key={sz} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <span className="mono" style={{ width: 28, fontSize: 11, color: "var(--muted)", textAlign: "right" }}>{sz}px</span>
                    <div style={{ width: sz, height: sz, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff", border: "1px solid var(--rule)", borderRadius: 3 }}>
                      <Mark size={sz} colorN={p.N} colorS={p.S} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <Foot left="bare svg" right="renders to 16px" />
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ─── Site header in context ─── */}
    <DCSection id="header" title="Site header in context">
      {PAIRS.map(p => (
        <DCArtboard key={p.id} id={`hdr-${p.id}`} label={`Header · ${p.name}`} width={640} height={300}>
          <div className="ab" style={{ background: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid var(--rule)", gap: 14 }}>
              <Mark size={32} colorN={p.N} colorS={p.S} />
              <Wordmark variant="split" size={20} />
              <div style={{ flex: 1 }} />
              <div className="mono" style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 18 }}>
                <span>Library</span><span>Drafts</span><span>Search</span>
              </div>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <div className="mono" style={{ fontSize: 10, color: "var(--muted)", letterSpacing: ".08em", marginBottom: 10 }}>WORKSPACE</div>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>
                Synaptic plasticity in cortical microcircuits
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {["12 sources", "3 drafts", "47 annotations"].map(t => (
                  <span key={t} className="mono" style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, background: "var(--paper-2)", color: "var(--ink)" }}>{t}</span>
                ))}
              </div>
            </div>
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ─── Avatars ─── */}
    <DCSection id="avatars" title="Social avatars" subtitle="Square + circle crops on dark">
      {PAIRS.map(p => (
        <DCArtboard key={p.id} id={`av-${p.id}`} label={`Avatar · ${p.name}`} width={420} height={260}>
          <div className="ab">
            <Tag>AVATAR</Tag>
            <div className="ab-stage" style={{ gap: 28, flexDirection: "row" }}>
              {[0, 1].map(circle => (
                <div key={circle} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 120, height: 120, background: "var(--ink)",
                    borderRadius: circle ? "50%" : 18,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Mark size={86}
                          colorN="white"
                          colorS="oklch(0.78 0.18 195)"
                          hub="oklch(0.78 0.18 130)" />
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                    {circle ? "circle" : "square"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </DCArtboard>
      ))}
    </DCSection>

    {/* ─── Motion + tokens ─── */}
    <DCSection id="motion" title="Motion + tokens">
      <DCArtboard id="spin" label="Loading spinner" width={340} height={340}>
        <div className="ab">
          <Tag>MOTION</Tag>
          <div className="ab-stage">
            <svg viewBox="0 0 96 96" width={180} height={180}>
              <g className="spin-host">
                <g fill="none" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 22 L22 70" stroke="var(--indigo)" />
                  <path d="M22 22 L52 60" stroke="var(--indigo)" />
                </g>
                <path d="M76 30 C 76 20, 58 20, 58 32 C 58 42, 74 44, 74 54 C 74 66, 56 66, 52 60"
                      fill="none" stroke="var(--teal)" strokeWidth="8" strokeLinecap="round" />
                <g fill="var(--paper)" strokeWidth="3">
                  <circle cx="22" cy="22" r="5" stroke="var(--indigo)" />
                  <circle cx="22" cy="70" r="5" stroke="var(--indigo)" />
                  <circle cx="76" cy="30" r="5" stroke="var(--teal)" />
                </g>
              </g>
              <circle cx="48" cy="48" r="6.5" fill="var(--ink)" style={{ animation: "pulse 1.2s ease-in-out infinite" }} />
            </svg>
          </div>
          <Foot left="2.4s loop · pulse hub" right="css only" />
        </div>
      </DCArtboard>

      <DCArtboard id="tokens" label="Color tokens" width={520} height={520}>
        <div className="ab">
          <Tag>TOKENS · CSS</Tag>
          <div className="ab-stage" style={{ alignItems: "stretch", padding: 24 }}>
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
              {TOKENS.map(t => (
                <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 0", borderBottom: "1px dashed var(--rule)" }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: `var(${t.name})`, border: t.name === "--paper" ? "1px solid var(--rule)" : "none" }} />
                  <span className="mono" style={{ fontSize: 12, fontWeight: 500, minWidth: 80 }}>{t.name}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--muted)", flex: 1 }}>{t.val}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)", textAlign: "right" }}>{t.desc}</span>
                </div>
              ))}
            </div>
          </div>
          <Foot left="oklch · perceptually uniform" right="copy / paste" />
        </div>
      </DCArtboard>
    </DCSection>
  </DesignCanvas>
);

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
