// gen-data.jsx — fixtures for the general chat surface.

const ME = { name: "Jin Park", avatar: "JP" };

// Flat list of general-chat sessions, sorted by recency.
// Pinned sessions float to the top within their own block.
const GEN_SESSIONS = [
  // pinned
  { id:"g0", title:"What I know about state-space models",         ago:"now",        n:2,  pinned:true,  starred:false },
  { id:"g1", title:"Quick: define induction head in one sentence", ago:"yesterday",  n:4,  pinned:true,  starred:true  },
  // active
  { id:"g2", title:"Compare PEFT methods · which for small VRAM?",  ago:"2h",         n:14, active:true },
  { id:"g3", title:"Stat power for repeated-measures n=12",         ago:"5h",         n:9   },
  { id:"g4", title:"Cosine vs dot-product for sentence embeddings", ago:"Wed",        n:7   },
  { id:"g5", title:"Outline a talk on circuit interp for non-ML",   ago:"Mon",        n:18  },
  { id:"g6", title:"Web search · best CRDT libraries in Rust",      ago:"May 12",     n:6   },
  { id:"g7", title:"Why is my colab GPU OOM at batch size 4",       ago:"May 10",     n:11  },
  { id:"g8", title:"Translate this German abstract",                ago:"May 8",      n:3   },
  { id:"g9", title:"Skim summary of arXiv 2503.12345",              ago:"May 4",      n:8   },
  // archived (visually muted)
  { id:"g10",title:"Rough notes for committee meeting",             ago:"Apr 30",     n:22, archived:true },
];

// A conversation a few turns in — used for the "active session" mock.
// Mixes plain prose answers (no citations) and a web-search-grounded one.
const GEN_MESSAGES = [
  { who:"user", at:"10:14", text:"Compare LoRA, DoRA, and prefix tuning. Which one for small VRAM?" },
  { who:"ai",   at:"10:14", model:"thorough",
    text:"All three freeze the base weights, but they differ in where they intervene. LoRA injects low-rank deltas into the attention projections (and sometimes the MLP); DoRA splits each weight into a magnitude vector and a direction, adapting the direction with LoRA and the magnitude separately; prefix tuning leaves the weights alone and prepends learned tokens to the key/value streams instead.\n\nFor small VRAM, prefix tuning is the cheapest to train but plateaus earliest. LoRA at rank 8–16 is the workhorse — small memory footprint, full-model expressive in practice. DoRA is roughly LoRA + 5–10% memory and reliably ~1 point better on most reasoning benchmarks; worth it unless you're truly out of room." },
  { who:"user", at:"10:16", text:"What about merging multiple LoRA adapters at inference?" },
  { who:"ai",   at:"10:16", model:"thorough", web:true,
    text:"There are a few patterns in current practice. The simplest is weighted summation of the deltas before deployment — works when adapters target the same modules. TIES-merging zeroes out conflicting signs first, which avoids interference between adapters trained on opposing tasks. LoRAHub and AdapterFusion learn the mixing weights, but you need a held-out set and they add latency.\n\nIf you only need a few combinations, training a small mixture-of-LoRAs gate is usually cleaner than runtime merging." },
];

// Starter-prompt chips for the landing state.
const STARTER_CHIPS = [
  { label:"Summarize a paper",          icon:"doc"      },
  { label:"Compare two methods",        icon:"layers"   },
  { label:"Define a term simply",       icon:"sparkles" },
  { label:"Outline a talk",             icon:"doc"      },
  { label:"Search the web",             icon:"search"   },
  { label:"Translate an abstract",      icon:"share"    },
];

Object.assign(window, { ME, GEN_SESSIONS, GEN_MESSAGES, STARTER_CHIPS });
