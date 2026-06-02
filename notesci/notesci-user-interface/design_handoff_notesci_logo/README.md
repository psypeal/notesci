# Handoff: notesci logo & identity

## Overview
This bundle contains the visual identity for **notesci** — a web app for scientific research e-document management, query, and drafting. The identity centers on a custom **NS lettermark** that doubles as a knowledge-graph metaphor, plus a lowercase wordmark. The two are decoupled by design: the icon is the project logo (favicons, app tile, social avatar), the wordmark sits in the site header next to it.

## About the Design Files
The HTML/JSX files in `references/` are **design references** — prototypes built in plain React-via-Babel that show the intended look, geometry, color usage, and motion. They are **not production code**. Your job is to recreate them in your application's existing environment (likely React + your CSS solution). If notesci's codebase doesn't exist yet, choose any modern frontend stack (React + Tailwind, Next.js, Vue, SvelteKit — your call) and implement there.

The `assets/` folder contains framework-agnostic SVG files you can drop into any project. The `snippets/` folder contains drop-in React + CSS implementations.

## Fidelity
**High-fidelity (hifi).** All colors, geometry coordinates, stroke widths, font weights, and spacing are final. Recreate pixel-perfectly.

---

## The mark

### Concept
The N and S share a single solid hub node where their strokes terminate. The hub is the visual anchor — "notes" and "science" converging into one point of knowledge. The three outer joints are **open rings** (graph node aesthetic, also keep the mark legible at 16px favicon size). Only the hub is a solid disc.

### Geometry (96×96 viewBox)

| Element | Path / coords | Stroke | Notes |
|---|---|---|---|
| N — left vertical | `M22 22 L22 70` | 8px round | colorN |
| N — diagonal | `M22 22 L52 60` | 8px round | colorN; lands on hub |
| S — single curve | `M76 30 C 76 20, 58 20, 58 32 C 58 42, 74 44, 74 54 C 74 66, 56 66, 52 60` | 8px round, no linejoin | colorS; bottom terminus is the hub |
| Outer ring nodes | circles at (22,22), (22,70), (76,30) | r=5, stroke 3px | fill = paper, stroke = matching glyph color |
| Hub node (anchor) | circle at (52,60) | r=6.5 | solid fill = ink |

### Color pairing — CANONICAL

| Pairing | N stroke | S stroke | Status |
|---|---|---|---|
| **Teal + indigo** | `oklch(0.52 0.22 274)` (indigo) | `oklch(0.62 0.14 195)` (teal) | ✅ **Canonical** — use this everywhere |
| Indigo + violet | `oklch(0.52 0.22 274)` | `oklch(0.55 0.22 305)` | reference only |
| Teal + violet | `oklch(0.55 0.22 305)` | `oklch(0.62 0.14 195)` | reference only |

Hub is always `#0e1116` (ink). Outer-ring fill is always `#f6f4ef` (paper) on light backgrounds.

### Mono variant
For one-color print or icon-mask systems, use `assets/icon-mono.svg` — every stroke + the hub uses `currentColor`; outer rings have `fill="transparent"` and a `currentColor` stroke.

### App-tile variant
For dark/contained icon contexts (favicon backgrounds, app-store tiles), use `assets/icon-app-tile.svg` — wraps the mark in a 22px-radius `#0e1116` rounded square. On dark, the N becomes white, S becomes `oklch(0.78 0.18 195)` (brighter teal), hub becomes `oklch(0.78 0.18 130)` (lime).

---

## The wordmark

### Type
- **Family:** Inter Tight (Google Fonts). Fallback stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Letterform:** all lowercase, written `notesci` (one word, no separator)
- **Letter-spacing:** `-0.03em`
- **Line-height:** `1`

### Three weight treatments
| Variant | Treatment | Use when |
|---|---|---|
| **split** *(default)* | `note` at weight **600**, `sci` at weight **500** in `--notesci-muted` | Header bar, where the icon does the color work |
| **accent** | both at weight **500**; `sci` colored in `--notesci-teal` | Standalone wordmark without an icon nearby |
| **uniform** | all weight **600**, single ink color | Tight footer, legal, dense UI |

### Sizes
- Site header: 20px
- Hero / marketing: 44–56px
- Footer: 14–16px
- Never below 14px (legibility floor)

---

## Lockup (icon + wordmark together)

When the icon and wordmark sit side-by-side:
- **Gap:** 14–16px between the icon's right edge and the `n` of `note`
- **Icon size:** 1.5× the wordmark font-size (e.g. 32px icon next to 20px wordmark)
- **Vertical alignment:** icon center aligned to wordmark's x-height midline (visually centered, not baseline)

See `assets/lockup-teal-indigo.svg` for the canonical lockup.

---

## Design Tokens

All in `snippets/tokens.css`. Summary:

```css
/* Neutrals */
--notesci-ink:    #0e1116;
--notesci-paper:  #f6f4ef;
--notesci-paper-2:#efece5;
--notesci-rule:   rgba(14, 17, 22, 0.12);
--notesci-muted:  rgba(14, 17, 22, 0.55);

/* Accents — same chroma/lightness, varying hue */
--notesci-indigo: oklch(0.52 0.22 274);
--notesci-teal:   oklch(0.62 0.14 195);
--notesci-violet: oklch(0.55 0.22 305);

/* For dark surfaces */
--notesci-teal-bright: oklch(0.78 0.18 195);
--notesci-lime-bright: oklch(0.78 0.18 130);

/* Type */
--notesci-font-sans: "Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--notesci-font-mono: "JetBrains Mono", ui-monospace, monospace;
```

---

## Motion (loading spinner)

The icon doubles as a brand-flavored loading indicator:
- The whole mark **rotates** around its center (48,48) on a 2.4s linear infinite loop
- The hub circle **pulses** opacity 0.4↔1 and radius 5↔7 on a 1.2s ease-in-out infinite loop
- Implemented in CSS only — no JS — so it works in any framework

```css
@keyframes nspin { to { transform: rotate(360deg); } }
@keyframes pulse {
  0%, 100% { opacity: .4; r: 5; }
  50%      { opacity: 1; r: 7; }
}
```

---

## Components delivered (`snippets/`)

| File | What it is |
|---|---|
| `NotesciIcon.tsx` | React + TypeScript component for the icon. Accepts `size`, `pairing` (`teal-indigo` \| `indigo-violet` \| `teal-violet` \| `mono`), and any standard SVG props. |
| `NotesciWordmark.tsx` | React + TypeScript component for the wordmark. Accepts `variant` (`split` \| `accent` \| `uniform`) and `size`. |
| `tokens.css` | All brand color + typography tokens as CSS custom properties. |

If your codebase uses a different framework (Vue, Svelte, SwiftUI, native), translate from these references — geometry stays identical.

---

## SVG assets (`assets/`)

| File | Use for |
|---|---|
| `icon-teal-indigo.svg` | Default brand icon |
| `icon-indigo-violet.svg` | Alt pairing |
| `icon-teal-violet.svg` | Alt pairing |
| `icon-mono.svg` | One-color print / icon masks (uses `currentColor`) |
| `icon-app-tile.svg` | Dark rounded-square tile (favicons on dark, app store) |
| `lockup-teal-indigo.svg` | Full horizontal lockup |
| `wordmark-split.svg` | Wordmark only, split treatment |

All icons render cleanly down to 16×16. Don't rasterize unless absolutely necessary; ship the SVG.

---

## Favicon implementation

```html
<link rel="icon" type="image/svg+xml" href="/icon-teal-indigo.svg">
<link rel="apple-touch-icon" href="/icon-app-tile.png"> <!-- export 180×180 from icon-app-tile.svg -->
```

---

## Reference files (`references/`)

| File | What's there |
|---|---|
| `notesci-identity.html` | The full identity sheet — all pairings, lockups, favicon scales, header mocks, avatars, motion, tokens |
| `notesci-logo v1 (explorations).html` | The original 8 directions explored before settling on concept 03 |
| `mark.jsx` | React source for the icon |
| `identity.jsx` | React source for the identity sheet layout |
| `design-canvas.jsx` | Pan/zoom canvas wrapper (only relevant to the references page) |
| `logos.jsx`, `app.jsx` | Source for the v1 explorations |

To preview locally, open either HTML file in a browser. They're self-contained except for fonts pulled from Google Fonts.

---

## Implementation checklist

- [x] Canonical color pairing: **teal + indigo** (locked)
- [ ] Add `tokens.css` to your global stylesheet
- [ ] Load **Inter Tight** (weights 400/500/600/700) — Google Fonts or self-host
- [ ] Drop `NotesciIcon` + `NotesciWordmark` into your component library
- [ ] Replace any placeholder logo in your site header with `<NotesciIcon size={32} /> <NotesciWordmark size={20} />`
- [ ] Wire up the SVG favicon
- [ ] Optional: implement the loading spinner with the rotating-mark + pulsing-hub pattern
- [ ] Generate raster fallbacks (180×180 apple-touch-icon, 32×32 ICO) only if your hosting requires them
