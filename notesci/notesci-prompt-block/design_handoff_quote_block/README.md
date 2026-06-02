# notesci · human-prompt block (V2 · Quote)

The locked-in design for rendering user messages in the conversation surface. Editorial pull-quote treatment — hairline rule with a brand-color top cap and an italic serif body. No card, no avatar, no surrounding meta. Designed to sit on a **white** chat surface.

## Files

| File | Role |
|---|---|
| `notesci-quote-block.html` | Open in a browser to preview the block — shows single-line and multi-line versions stacked on white. |
| `quote-block.jsx` | The `QuoteBlock` component. Single prop: `text`. Optional `width` (default 680). |
| `README.md` | This file. |

## Specs

| Property | Value |
|---|---|
| Container width | 680px (suggested; flows naturally if narrower) |
| Padding | 28px top, 8px right, 28px bottom, 40px left |
| Rule | 1px wide, positioned at `left: 20px`, full height |
| Rule top cap | `--indigo` for the top 14%, `--rule-2` for the rest (linear gradient) |
| Body font | "Source Serif 4", italic, weight 500 |
| Body font size | 20px |
| Body line height | 1.45 |
| Body letter-spacing | -0.005em |
| Body color | `--ink` |
| `text-wrap` | `pretty` |

## Tokens

Define these on `:root` (or substitute with your design system's equivalents):

```css
:root {
  --ink:    #0e1116;
  --rule-2: rgba(14, 17, 22, 0.18);
  --indigo: oklch(0.52 0.22 274);
}
```

## Fonts

The block requires **Source Serif 4** with italic weight 500 loaded. Easiest path is Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@1,500&display=swap" rel="stylesheet">
```

If your codebase already has a serif loaded, use that — anything serif/italic at editorial size will read correctly; the rule + tracking does the structural work.

## Usage

```jsx
<QuoteBlock text="Where do induction heads emerge in small models?" />

<QuoteBlock
  text="Compare how Olsson '22 and Wang '23 characterize the role of induction heads — and where the working-memory framing in Cowan '17 pushes against either."
/>
```

That's it.

## Design intent

The user is asking a question in the same notebook the assistant answers from — both voices use serif body type. The hairline rule marks the prompt as the user's voice without separating it onto a different surface (no card, no bubble). The indigo cap on the rule is the only point of brand color in the block, deliberately small and at the start, so a long thread reads as a column of cleanly demarcated quotes.

## What to avoid

- **No decorative quotation glyph.** The rule + italic already says "quoted". Adding a `"` doubles the cue.
- **No avatar, no name, no timestamp** inside the block. If you need them, render them as a separate row above with whatever your app's meta convention is — keep the block itself pure.
- **No background fill.** Sit it on white. A subtle paper tint is OK if the rest of the conversation surface uses the same paper tint, but white is the canonical case.
