// QuoteBlock — notesci's human-prompt message block (V2 · Quote).
//
// Used to render the user's message in the conversation. Designed to sit
// on a WHITE chat surface — no card, just a hairline rule with a brand-
// color top cap and an italic serif body.
//
// Tokens used (define on :root or substitute with your design system):
//   --ink     #0e1116
//   --rule-2  rgba(14,17,22,.18)
//   --indigo  oklch(0.52 0.22 274)
//   "Source Serif 4" (italic, weight 500)
//
// Width is a hint, not a hard constraint — the block flows naturally if
// the parent is narrower.

const QuoteBlock = ({ text, width = 680 }) => (
  <div style={{ width, position: "relative", padding: "28px 8px 28px 40px" }}>
    {/* Hairline rule — indigo cap on the top 14%, neutral the rest of the way. */}
    <span
      style={{
        position: "absolute",
        left: 20, top: 0, bottom: 0, width: 1,
        background:
          "linear-gradient(180deg, var(--indigo) 0%, var(--indigo) 14%, var(--rule-2) 14%, var(--rule-2) 100%)",
      }}
    />
    <div
      className="serif"
      style={{
        fontSize: 20,
        lineHeight: 1.45,
        color: "var(--ink)",
        fontStyle: "italic",
        fontWeight: 500,
        letterSpacing: "-0.005em",
        textWrap: "pretty",
      }}
    >
      {text}
    </div>
  </div>
);

window.QuoteBlock = QuoteBlock;
