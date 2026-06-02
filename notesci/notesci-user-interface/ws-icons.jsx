// ws-icons.jsx — small inline-SVG icons used across the workspace.
// Stroke-based, currentColor, 16px default — fits the editorial look.

const Icon = ({ d, size = 16, fill = "none", stroke = "currentColor", strokeWidth = 1.6, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
    {children || <path d={d}/>}
  </svg>
);
const Icons = {
  search:    (p={}) => <Icon {...p}><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5"/></Icon>,
  plus:      (p={}) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  chevDown:  (p={}) => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>,
  chevRight: (p={}) => <Icon {...p}><path d="m9 6 6 6-6 6"/></Icon>,
  folder:    (p={}) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></Icon>,
  pdf:       (p={}) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></Icon>,
  note:      (p={}) => <Icon {...p}><path d="M9 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4"/><path d="m18 2 4 4-9 9-4 1 1-4z"/></Icon>,
  doc:       (p={}) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></Icon>,
  star:      (p={}) => <Icon {...p}><path d="m12 3 2.7 5.5 6 .9-4.4 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3 9.4l6-.9z"/></Icon>,
  starFill:  (p={}) => <Icon fill="currentColor" stroke="none" {...p}><path d="m12 3 2.7 5.5 6 .9-4.4 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3 9.4l6-.9z"/></Icon>,
  send:      (p={}) => <Icon {...p}><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></Icon>,
  gift:      (p={}) => <Icon {...p}><path d="M20 12v9H4v-9"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></Icon>,
  attach:    (p={}) => <Icon {...p}><path d="m21 12-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8.5-8.5"/></Icon>,
  slash:     (p={}) => <Icon {...p}><path d="M16 4 8 20"/></Icon>,
  bot:       (p={}) => <Icon {...p}><rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 4v4M9 14h.01M15 14h.01"/></Icon>,
  user:      (p={}) => <Icon {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></Icon>,
  pin:       (p={}) => <Icon {...p}><path d="M12 17v5"/><path d="m9 12 3 3 3-3 4-4-6-6-4 4z"/></Icon>,
  kebab:     (p={}) => <Icon {...p}><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></Icon>,
  graph:     (p={}) => <Icon {...p}><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8 7 8 0M7.5 8l4 8M16.5 8l-4 8"/></Icon>,
  filter:    (p={}) => <Icon {...p}><path d="M3 5h18l-7 9v6l-4-2v-4z"/></Icon>,
  reset:     (p={}) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></Icon>,
  zoomIn:    (p={}) => <Icon {...p}><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/></Icon>,
  layers:    (p={}) => <Icon {...p}><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></Icon>,
  eye:       (p={}) => <Icon {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></Icon>,
  share:     (p={}) => <Icon {...p}><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m8.5 10.5 7-3M8.5 13.5l7 3"/></Icon>,
  plug:      (p={}) => <Icon {...p}><path d="M9 2v6M15 2v6M5 10h14v4a4 4 0 0 1-4 4h-1v4h-4v-4H9a4 4 0 0 1-4-4z"/></Icon>,
  arrowsIn:  (p={}) => <Icon {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></Icon>,
  arrowsOut: (p={}) => <Icon {...p}><path d="M3 9V3h6M21 15v6h-6M3 3l7 7M21 21l-7-7"/></Icon>,
  sparkles:  (p={}) => <Icon {...p}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></Icon>,
  book:      (p={}) => <Icon {...p}><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></Icon>,
  download:  (p={}) => <Icon {...p}><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></Icon>,
};
window.Icons = Icons;
