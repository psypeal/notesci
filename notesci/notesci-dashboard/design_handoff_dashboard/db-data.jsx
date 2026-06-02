// db-data.jsx — fixture data for the dashboard mocks.

const ME = { name: "Jin Park", email: "jin@stanford.edu", role: "Researcher · Cog Sci", avatar: "JP", workspace: "Park Lab" };

const MEMBERS = [
  { initials:"JP", name:"Jin Park",       email:"jin@stanford.edu",    role:"Owner",  status:"active",  joined:"Apr 12" },
  { initials:"RL", name:"Ramesh Lakshmi", email:"ramesh@stanford.edu", role:"Admin",  status:"active",  joined:"Apr 14" },
  { initials:"MO", name:"Mira Okafor",    email:"mira@stanford.edu",   role:"Member", status:"active",  joined:"Apr 18" },
  { initials:"SK", name:"Sven Køhler",    email:"sven@cph.dk",         role:"Member", status:"active",  joined:"Apr 22" },
  { initials:"AT", name:"Aiko Tanaka",    email:"aiko@stanford.edu",   role:"Viewer", status:"active",  joined:"Apr 28" },
  { initials:"?",  name:"daniel@stanford.edu", email:"daniel@stanford.edu", role:"Member", status:"pending", joined:"sent 2h ago" },
];

const SOURCES = [
  { id:"zotero",  name:"Zotero",       desc:"Sync your library and annotations", color:"#cc2936", connected:true,  account:"jin@stanford.edu", last:"synced 14m ago" },
  { id:"notion",  name:"Notion",       desc:"Pull pages and databases as notes", color:"#000",    connected:true,  account:"Park Lab workspace", last:"synced 1h ago" },
  { id:"drive",   name:"Google Drive", desc:"Index PDFs and documents",          color:"#1a73e8", connected:false },
  { id:"readwise",name:"Readwise",     desc:"Import highlights and articles",    color:"#222",    connected:false },
  { id:"arxiv",   name:"arXiv saves",  desc:"Watch new papers in subscribed cats", color:"#b31b1b", connected:true, account:"5 categories", last:"synced 6h ago" },
  { id:"orcid",   name:"ORCID",        desc:"Pull your published works",         color:"#a6ce39", connected:false },
];

const MCP_CATS = ["Featured","Research","Writing","Data","Productivity","Code","Web","Lab tools"];

const MCP_SERVERS = [
  { id:"semscholar", name:"Semantic Scholar",    cat:"Research",   author:"AllenAI",        desc:"Full-text search over 200M+ papers, citation graph, author lookup.", rating:4.9, installs:"42k", featured:true, official:true, installed:true,  status:"healthy" },
  { id:"arxiv",      name:"arXiv",               cat:"Research",   author:"arXiv-mcp",      desc:"Search arXiv by title, author, or category. Fetch PDFs and abstracts.", rating:4.8, installs:"38k", featured:true, official:true, installed:true,  status:"healthy" },
  { id:"pubmed",     name:"PubMed",              cat:"Research",   author:"NCBI",           desc:"Biomedical literature search with MeSH terms and trial data.",       rating:4.7, installs:"24k", featured:true, official:true },
  { id:"connpapers", name:"ConnectedPapers",     cat:"Research",   author:"connectedpapers",desc:"Visualize how a paper relates to its scholarly neighborhood.",       rating:4.6, installs:"19k" },
  { id:"hf",         name:"HuggingFace Hub",     cat:"Data",       author:"huggingface",    desc:"Browse datasets and models; pull README and metadata.",              rating:4.5, installs:"31k", featured:true },
  { id:"wandb",      name:"Weights & Biases",    cat:"Data",       author:"wandb",          desc:"Query your runs, sweeps, and artifacts in conversation.",            rating:4.7, installs:"12k", installed:true, status:"reauth" },
  { id:"github",     name:"GitHub",              cat:"Code",       author:"github",         desc:"Read repos, issues, PRs; comment from notesci.",                     rating:4.8, installs:"58k", official:true, installed:true,  status:"healthy" },
  { id:"linear",     name:"Linear",              cat:"Productivity",author:"linear",        desc:"Search and create issues; sync research tasks to your team.",        rating:4.6, installs:"22k" },
  { id:"slack",      name:"Slack",               cat:"Productivity",author:"slack",         desc:"Search channels, post answers, share sessions.",                     rating:4.4, installs:"40k" },
  { id:"firecrawl",  name:"Firecrawl",           cat:"Web",        author:"firecrawl",      desc:"Crawl any site to clean Markdown for grounding.",                    rating:4.6, installs:"18k" },
  { id:"tavily",     name:"Tavily Web Search",   cat:"Web",        author:"tavily",         desc:"AI-friendly web search with structured snippets.",                   rating:4.7, installs:"27k", installed:true,  status:"limited" },
  { id:"jupyter",    name:"Jupyter",             cat:"Lab tools",  author:"jupyter",        desc:"Run cells in a sandboxed kernel; read notebooks.",                   rating:4.5, installs:"9k" },
  { id:"obsidian",   name:"Obsidian",            cat:"Writing",    author:"obsidian",       desc:"Read/write notes in your vault, follow [[links]].",                  rating:4.7, installs:"21k" },
  { id:"perplexity", name:"Perplexity",          cat:"Web",        author:"perplexity",     desc:"Cited web answers as a tool call.",                                  rating:4.5, installs:"15k" },
];

const API_KEYS = [
  { id:"k1", name:"Local CLI",   prefix:"nsk_live_a91…", created:"Apr 12", lastUsed:"3m ago",   scopes:["read:projects","write:sessions"] },
  { id:"k2", name:"Lab dashboard",prefix:"nsk_live_77c…", created:"Apr 18", lastUsed:"yesterday",scopes:["read:projects"] },
  { id:"k3", name:"Notebook scratch", prefix:"nsk_test_032…", created:"Apr 28", lastUsed:"never", scopes:["read:projects","write:sessions","admin:mcps"] },
];

const WEBHOOKS = [
  { id:"w1", url:"https://parklab.dev/hooks/notesci", events:["session.completed","material.added"], status:"healthy", deliveries:"218 / 220" },
  { id:"w2", url:"https://hooks.slack.com/T0…/B0…",   events:["session.shared"],                     status:"failing", deliveries:"4 / 12" },
];

const AUDIT = [
  { who:"Jin Park",       what:"installed MCP",          target:"Semantic Scholar", at:"14:02 today" },
  { who:"Ramesh Lakshmi", what:"invited member",         target:"daniel@stanford.edu", at:"12:18 today" },
  { who:"Mira Okafor",    what:"changed role",           target:"Aiko · Member → Viewer", at:"yesterday" },
  { who:"Jin Park",       what:"connected source",       target:"Notion · Park Lab", at:"Apr 28" },
  { who:"Jin Park",       what:"created project",        target:"RLHF reward shaping survey", at:"Apr 26" },
  { who:"Jin Park",       what:"rotated API key",        target:"nsk_live_a91…", at:"Apr 18" },
];

const LIBRARY = [
  { kind:"project",  name:"Working memory & transformer interpretability", meta:"23 sources · 6 sessions", at:"now" },
  { kind:"session",  name:"Where do induction heads emerge in small models?", meta:"in wm·tr · 14 msgs", at:"10:14" },
  { kind:"material", name:"Olsson '22 — Induction heads.pdf", meta:"in wm·tr · Foundations", at:"Apr 14" },
  { kind:"material", name:"Wang '23 — Interpretability in the wild.pdf", meta:"in wm·tr · Foundations", at:"Apr 14" },
  { kind:"project",  name:"RLHF reward shaping survey", meta:"11 sources · 3 sessions", at:"yesterday" },
  { kind:"session",  name:"Compare Olsson '22 vs Wang '23 on retrieval heads", meta:"in wm·tr · 22 msgs", at:"yesterday" },
  { kind:"material", name:"Note · capacity vs. attention", meta:"in wm·tr · Cogsci", at:"Apr 24" },
  { kind:"project",  name:"Intro to mechanistic interp (lit notes)", meta:"47 sources · 1 session", at:"Apr 22" },
];

Object.assign(window, { ME, MEMBERS, SOURCES, MCP_CATS, MCP_SERVERS, API_KEYS, WEBHOOKS, AUDIT, LIBRARY });
