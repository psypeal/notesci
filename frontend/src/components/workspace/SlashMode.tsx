/**
 * Slash-mode detection + inline syntax-highlighting overlay.
 *
 * The composer surfaces paint the leading `/<command>` with an
 * indigo color treatment and append a grey ghost-text hint. The
 * detection also handles *partial* matches: typing `/d` while
 * `/draft` is a known command paints `/d` in indigo and the
 * remaining `raft` as grey ghost text, followed by the command's
 * hint. The user types in a normal `<textarea>` — we just paint a
 * mirror layer behind it that recreates the same text with
 * highlighting. The textarea's text color is set to transparent
 * (caret stays visible via `caret-color`), so the mirror's painted
 * version is what reads.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { SlashCommand } from './ChatPane'

export type SlashMode =
  /** The input exactly matches a known command (with or without a
   *  trailing space). `needsSpace` is true until the user types the
   *  separator. */
  | { kind: 'full'; command: SlashCommand; needsSpace: boolean }
  /** The input is a strict prefix of a known command's name (e.g.
   *  `/d` while `/draft` is known). `typed` preserves the original
   *  casing; `completion` is the rest of the command label that
   *  would auto-complete it. */
  | {
      kind: 'partial'
      command: SlashCommand
      typed: string
      completion: string
    }

export function detectSlashMode(
  input: string,
  commands: readonly SlashCommand[],
): SlashMode | null {
  // Full match: input begins with `/<word>` followed by a space or
  // end-of-input, and the word is a known command.
  const full = input.match(/^\/([\w-]+)(\s|$)/)
  if (full) {
    const label = '/' + full[1].toLowerCase()
    const command = commands.find((c) => c.label.toLowerCase() === label)
    if (command) {
      return { kind: 'full', command, needsSpace: full[2] === '' }
    }
  }
  // Partial match: input begins with `/<prefix>` and nothing else
  // (no trailing space, no extra chars). `prefix` must be at least
  // one char and must be a prefix of some command's name.
  const partial = input.match(/^\/([\w-]*)$/)
  if (partial) {
    const typed = partial[1].toLowerCase()
    if (typed) {
      const candidates = commands.filter((c) =>
        c.label.slice(1).toLowerCase().startsWith(typed),
      )
      if (candidates.length > 0) {
        // Prefer the alphabetically-first match when the prefix is
        // ambiguous (e.g. `/d` matches both `/draft` and `/discover`
        // — pick `/discover`). The slash popover separately shows
        // all candidates.
        candidates.sort((a, b) => a.label.localeCompare(b.label))
        const command = candidates[0]
        const completion = command.label.slice(1 + typed.length)
        return {
          kind: 'partial',
          command,
          typed: '/' + partial[1], // preserve original casing
          completion,
        }
      }
    }
  }
  return null
}

/**
 * Mirror layer that paints the textarea's text with the leading
 * slash command highlighted. Positions itself absolutely on top of
 * the textarea (which renders with transparent text) — keep the
 * font/padding/line-height props identical to the textarea or wrap
 * lines will diverge.
 */
export function SlashMirror({
  value,
  placeholder = '',
  commands,
  style,
  className,
}: {
  value: string
  /** Shown in muted grey when value is empty — replaces the native
   *  textarea placeholder (which is hidden by the transparent text). */
  placeholder?: string
  commands: readonly SlashCommand[]
  /** Should mirror the textarea's font/padding so the painted
   *  characters line up under the caret. */
  style?: CSSProperties
  className?: string
}) {
  return (
    <div
      aria-hidden
      className={`ns-slash-mirror ${className ?? ''}`}
      style={style}
    >
      {renderHighlighted(value, placeholder, commands)}
    </div>
  )
}

function renderHighlighted(
  value: string,
  placeholder: string,
  commands: readonly SlashCommand[],
): ReactNode {
  if (!value) {
    return <span className="ns-slash-placeholder">{placeholder}</span>
  }
  const mode = detectSlashMode(value, commands)
  if (!mode) {
    return value
  }
  if (mode.kind === 'partial') {
    // `/d` (indigo) + `raft` (grey ghost, the suggested completion)
    // + ` <hint>` (grey ghost, the command's description).
    return (
      <>
        <span className="ns-slash-token">{mode.typed}</span>
        <span className="ns-slash-ghost">{mode.completion}</span>
        <span className="ns-slash-ghost">{' ' + mode.command.hint}</span>
      </>
    )
  }
  // Full match.
  const label = mode.command.label
  const rest = value.slice(label.length)
  return (
    <>
      <span className="ns-slash-token">{label}</span>
      {mode.needsSpace ? (
        <span className="ns-slash-ghost">{' ' + mode.command.hint}</span>
      ) : (
        rest
      )}
    </>
  )
}
