// NotesciWordmark.tsx — text wordmark, decoupled from the icon.

import * as React from "react";

type Variant = "split" | "accent" | "uniform";

export interface NotesciWordmarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
  size?: number;            // px font-size
  ink?: string;
  muted?: string;
  accent?: string;
}

export const NotesciWordmark: React.FC<NotesciWordmarkProps> = ({
  variant = "split",
  size = 20,
  ink = "#0e1116",
  muted = "rgba(14,17,22,0.55)",
  accent = "oklch(0.62 0.14 195)",
  style,
  ...rest
}) => {
  const base: React.CSSProperties = {
    fontFamily: '"Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: size,
    letterSpacing: "-0.03em",
    lineHeight: 1,
    color: ink,
    display: "inline-flex",
    alignItems: "baseline",
    ...style,
  };
  if (variant === "split") {
    return (
      <span style={base} {...rest}>
        <span style={{ fontWeight: 600 }}>note</span>
        <span style={{ fontWeight: 500, color: muted }}>sci</span>
      </span>
    );
  }
  if (variant === "accent") {
    return (
      <span style={base} {...rest}>
        <span style={{ fontWeight: 500 }}>note</span>
        <span style={{ fontWeight: 500, color: accent }}>sci</span>
      </span>
    );
  }
  return <span style={{ ...base, fontWeight: 600 }} {...rest}>notesci</span>;
};

export default NotesciWordmark;
