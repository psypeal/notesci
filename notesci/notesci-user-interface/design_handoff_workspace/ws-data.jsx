// ws-data.jsx — fixture data for the workspace mocks.
// Project: "Working memory & transformer interpretability"

const PROJECT = {
  id: "wm-tr",
  name: "Working memory & transformer interpretability",
  short: "wm·tr",
  tags: ["cognitive-science", "interp", "drafting"],
};

const PROJECTS = [
  { id: "wm-tr",  name: "Working memory & transformer interpretability", short: "wm·tr", count: 23 },
  { id: "rlhf",   name: "RLHF reward shaping survey",                    short: "rlhf",  count: 11 },
  { id: "intro",  name: "Intro to mechanistic interp (lit notes)",       short: "intro", count: 47 },
  { id: "review", name: "Q3 review · attention papers",                  short: "review",count: 9  },
];

const SESSIONS = [
  { id: "s-now", title: "Where do induction heads emerge in small models?",  ago: "now",     n: 14, active: true,  pinned: true },
  { id: "s1",    title: "Compare Olsson '22 vs Wang '23 on retrieval heads", ago: "2h",      n: 22, active: false, pinned: true },
  { id: "s2",    title: "Draft: \"Working memory benchmarks for LMs\"",       ago: "yesterday", n: 7, active: false, draft: true },
  { id: "s3",    title: "Quick: which papers cite Tracr?",                   ago: "Apr 28",  n: 4 },
  { id: "s4",    title: "Skim summary · 5 papers from saved feed",           ago: "Apr 27",  n: 11 },
  { id: "s5",    title: "Counter-arguments to circuit interpretation",      ago: "Apr 22",  n: 19 },
];

const MATERIALS = [
  { type: "folder", id: "f1", name: "Foundations", count: 6, open: true, children: [
    { type: "pdf",  id: "m1",  name: "Anthropic '23 — Toy models of superposition.pdf", size: "2.4 MB", year: "2023", starred: true },
    { type: "pdf",  id: "m2",  name: "Olsson et al. '22 — Induction heads.pdf",          size: "3.1 MB", year: "2022", starred: true },
    { type: "pdf",  id: "m3",  name: "Elhage et al. '21 — Mathematical framework.pdf",   size: "1.8 MB", year: "2021" },
    { type: "pdf",  id: "m4",  name: "Wang et al. '23 — Interpretability in the wild.pdf", size: "4.2 MB", year: "2023" },
  ]},
  { type: "folder", id: "f2", name: "Working memory · cognitive science", count: 5, open: true, children: [
    { type: "pdf",  id: "m5",  name: "Baddeley '12 — Working memory: theories.pdf", size: "1.1 MB", year: "2012" },
    { type: "pdf",  id: "m6",  name: "Cowan '17 — Magic of 4 chunks.pdf",          size: "740 KB", year: "2017" },
    { type: "note", id: "m7",  name: "Note · capacity vs. attention",              size: "—",      year: "Apr 24" },
  ]},
  { type: "folder", id: "f3", name: "Drafts", count: 2, open: false, children: [
    { type: "doc",  id: "m8",  name: "Working memory benchmarks for LMs.md", size: "12 KB", year: "Apr 30", draft: true },
    { type: "doc",  id: "m9",  name: "Talk outline · Brown reading group.md", size: "4 KB",  year: "Apr 18" },
  ]},
  { type: "folder", id: "f4", name: "Web clips", count: 4, open: false, children: [] },
];

// Last assistant answer with inline citations.
// Each [n] maps to MATERIALS_INDEX[n].
const ANSWER_CITATIONS = ["m2", "m1", "m4", "m6"];
const MATERIALS_INDEX = {
  m1: { name: "Toy models of superposition",   year: 2023, kind: "pdf"  },
  m2: { name: "Induction heads",                year: 2022, kind: "pdf"  },
  m3: { name: "Mathematical framework",         year: 2021, kind: "pdf"  },
  m4: { name: "Interpretability in the wild",   year: 2023, kind: "pdf"  },
  m5: { name: "Working memory: theories",       year: 2012, kind: "pdf"  },
  m6: { name: "Magic of 4 chunks",              year: 2017, kind: "pdf"  },
  m7: { name: "Note · capacity vs. attention",  year: 2024, kind: "note" },
  m8: { name: "Working memory benchmarks (draft)", year: 2024, kind: "doc"  },
};

// Conversation
const MESSAGES = [
  { who: "user", at: "10:14", text: "When training transformers from scratch, when do induction heads typically emerge — and is the timing consistent across model sizes?" },
  { who: "ai",   at: "10:14", model: "thorough",
    text: "Across the small-model regime studied by Olsson et al., induction heads form abruptly during a narrow training window, usually coinciding with a sharp drop in loss [1]. The phenomenon shows up across widths from 70M up to 13B, with the transition often surprisingly aligned in tokens-seen rather than wall-clock steps [1][2]. Interpretability-in-the-wild work on GPT-2 small confirms the same circuits exist post-hoc [3]; whether the *capacity* of those heads matches the working-memory chunk limits in humans is open [4].",
    cites: [
      { n:1, m:"m2" }, { n:2, m:"m1" }, { n:3, m:"m4" }, { n:4, m:"m6" },
    ]
  },
  { who: "user", at: "10:16", text: "Pull the figures from Olsson §3 that show the transition." },
];

// Scope chips above the chat input
const SCOPED_SOURCES = [
  { id: "m2", name: "Olsson '22",       kind: "pdf" },
  { id: "m1", name: "Toy models",       kind: "pdf" },
  { id: "m4", name: "Wang '23",         kind: "pdf" },
  { id: "m7", name: "capacity-vs-attention", kind: "note" },
];

Object.assign(window, { PROJECT, PROJECTS, SESSIONS, MATERIALS, MATERIALS_INDEX, ANSWER_CITATIONS, MESSAGES, SCOPED_SOURCES });
