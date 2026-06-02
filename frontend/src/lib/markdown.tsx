/**
 * Lightweight, dependency-free Markdown renderer for chat output.
 *
 * Why hand-rolled instead of react-markdown: the project keeps a
 * deliberately tiny dependency list, and LLM chat output uses a
 * well-bounded subset of Markdown. This covers that subset —
 * headings, bold/italic, inline + fenced code, ordered/unordered
 * lists, links, blockquotes, horizontal rules, GFM tables,
 * paragraphs — and nothing else (no HTML passthrough, no nested-list
 * trees beyond a single indent level).
 *
 * Security: every node is a real React element — there is no
 * `dangerouslySetInnerHTML` anywhere, so script/HTML in the model
 * output is rendered as inert text. Link hrefs are validated to
 * http(s) before they reach the DOM.
 *
 * It also preserves notesci's `[N]` citation markers: a bare
 * `[<digits>]` (not part of a `[text](url)` link) renders as the
 * clickable `.cite` button wired to `onClickCitation`.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { isSafeHttpUrl } from './redirect'
import { openInSystemBrowser } from './tauri'

export interface RetrievedRef {
  chunk_id: number
  material_id: string
  title: string | null
  distance?: number
  material_url?: string | null
  marker_n?: number | null
  source_kind?: 'internal' | 'external' | null
}

/** Detail passed to the citation-click handler. Splits the material
 *  (which file to open) from the chunk (which passage inside it) so
 *  callers that wire a reader can scroll to the cited passage instead
 *  of dropping the user at page 1 every time. */
export interface CitationClick {
  materialId: string
  chunkId: number
  title: string | null
  materialUrl?: string | null
}

interface Ctx {
  retrieved: RetrievedRef[]
  onClickCitation?: (detail: CitationClick) => void
  onLinkClick?: (
    href: string,
  ) =>
    | void
    | boolean
    | McpLinkAction
    | Promise<void | boolean | McpLinkAction>
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const fallback = document.createElement('textarea')
    fallback.value = text
    fallback.setAttribute('readonly', '')
    fallback.style.position = 'fixed'
    fallback.style.opacity = '0'
    document.body.appendChild(fallback)
    fallback.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(fallback)
    return ok
  }
}

function CodeCopyButton({ codeText, idPrefix }: { codeText: string; idPrefix: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    const ok = await copyToClipboard(codeText)
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button
      type="button"
      className="md-copy-btn"
      aria-label={`${copied ? 'Copied code block' : 'Copy code block'} ${idPrefix}`}
      onClick={() => void onCopy()}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

interface McpLinkAction {
  handled: boolean
  open: boolean
  tone?: 'info' | 'success' | 'warn' | 'error'
  message?: string
}

async function applyLinkAction(
  href: string,
  onLinkClick?: Ctx['onLinkClick'],
): Promise<boolean> {
  if (!onLinkClick) return false

  try {
    const action = await onLinkClick(href)

    if (typeof action === 'boolean') return action
    if (action && typeof action === 'object' && action.handled) {
      return !action.open
    }
  } catch {
    /* keep the click resilient — at worst, fall back to opening */
  }

  return false
}

// Inline tokens, in precedence order (alternation is left-to-right at
// each scan position):
//   1. `code`            — literal, no inner parsing
//   2. [text](url)       — link
//   3. [N]               — citation marker (digits only, not a link)
//   4. http(s) / www URL  — raw web link
//   5. **bold**          — content captured in group 5, parsed recursively
//   6. *italic*          — content captured in group 6, parsed recursively
//
// The bold pattern is `\*\*(.+?)\*\*` (non-greedy, content MAY contain
// single `*`) so a nested emphasis like `**What I *cannot* do**` is
// matched as one bold span — the previous `[^*]+` body couldn't, which
// left the `**` markers as literal text and only italicised the inner
// word. Bold/italic inner content is fed back through `renderInline`
// so nesting renders correctly.
//
// Underscore-italic is intentionally omitted — `snake_case` identifiers
// are common in scientific text and would false-match.
const INLINE_RE =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\((?:[^()\s]+|\([^)\s]*\))+\))|(\[(?:[IiWw])?\d+(?:\s*,\s*(?:[IiWw])?\d+)*\])|(\b(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)|\*\*(.+?)\*\*|\*([^*\n]+)\*/g

function normalizeUrlToken(raw: string): string {
  return raw.trim().replace(/[)\].,:!?;]+$/g, '')
}

function resolveMarkdownHref(rawUrl: string): string | null {
  const normalized = normalizeUrlToken(rawUrl)
  const url = normalized.startsWith('www.')
    ? `https://${normalized}`
    : normalized
  if (isSafeHttpUrl(url)) return url

  // Notesci in-chat install links use a dedicated scheme:
  // notesci://mcp/install/<catalog_id>. They are intentionally
  // handled by the app, not opened in the browser.
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol === 'notesci:' &&
      parsed.hostname.toLowerCase() === 'mcp'
    ) {
      return url
    }
  } catch {
    return null
  }
  return null
}

// Guard against pathological inputs recursing without bound. Real LLM
// emphasis nests 1–2 deep; 6 is far past anything legitimate.
const MAX_INLINE_DEPTH = 6
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isInternalRef(r: RetrievedRef): boolean {
  if (!UUID_RE.test(r.material_id)) return false
  if (r.source_kind === 'internal') return true
  if (r.source_kind === 'external') return false
  return true
}

function citationRef(ctx: Ctx, marker: number): RetrievedRef | undefined {
  const internal = ctx.retrieved.filter(isInternalRef)
  const numbered = internal.filter((r) => r.marker_n != null)
  const explicit = numbered.find((r) => r.marker_n === marker)
  if (explicit) return explicit
  if (numbered.length > 0) return undefined
  return internal[marker - 1]
}

function externalCitationRef(ctx: Ctx, marker: number): RetrievedRef | undefined {
  const external = ctx.retrieved.filter((r) => !isInternalRef(r))
  const numbered = external.filter((r) => r.marker_n != null)
  const explicit = numbered.find((r) => r.marker_n === marker)
  if (explicit) return explicit
  if (numbered.length > 0) return undefined
  return (
    external[marker - 1]
  )
}

function legacyCitationRef(ctx: Ctx, marker: number): RetrievedRef | undefined {
  const internal = ctx.retrieved.filter(isInternalRef)
  const external = ctx.retrieved.filter((r) => !isInternalRef(r))
  if (external.length > 0 && internal.length === 0) return externalCitationRef(ctx, marker)
  if (external.length === 0) return citationRef(ctx, marker)
  return undefined
}

function renderInline(
  text: string,
  ctx: Ctx,
  kp: string,
  depth = 0,
): ReactNode[] {
  if (depth >= MAX_INLINE_DEPTH) return [<span key={`${kp}-raw`}>{text}</span>]
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  const re = new RegExp(INLINE_RE.source, 'g')
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<span key={`${kp}-t${i}`}>{text.slice(last, m.index)}</span>)
    }
    const tok = m[0]
    if (m[1]) {
      out.push(
        <code key={`${kp}-c${i}`} className="md-code">
          {m[1].slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      const lm = /^\[([^\]]+)\]\(((?:[^()\s]+|\([^)\s]*\))+)\)$/.exec(m[2])
      const label = lm ? lm[1] : m[2]
      const rawHref = lm ? lm[2] : ''
      const href = resolveMarkdownHref(rawHref)
      out.push(
        href ? (
          <a
            key={`${kp}-l${i}`}
            href={href}
            className="md-link"
            onClick={(e) => {
              e.preventDefault()
              void applyLinkAction(href, ctx.onLinkClick).then((blocked) => {
                if (!blocked) {
                  openInSystemBrowser(href)
                }
              })
            }}
          >
            {label}
          </a>
        ) : (
          <span key={`${kp}-l${i}`}>{label}</span>
        ),
      )
    } else if (m[3]) {
      const refs = m[3].slice(1, -1).split(/\s*,\s*/).map((raw) => {
        const trimmed = raw.trim()
        const prefix = /^[IW]/i.test(trimmed) ? trimmed[0].toUpperCase() : ''
        const n = parseInt(trimmed.replace(/^[IW]/i, ''), 10)
        return { prefix, n }
      })
      refs.forEach(({ prefix, n }, idx) => {
        const r =
          prefix === 'I'
            ? citationRef(ctx, n)
            : prefix === ''
              ? legacyCitationRef(ctx, n)
              : undefined
        if (idx > 0) out.push(<span key={`${kp}-cite${i}-sep${idx}`}>, </span>)
        const external =
          prefix === 'W'
            ? externalCitationRef(ctx, n)
            : !r && prefix === ''
              ? externalCitationRef(ctx, n)
              : undefined
        const label = prefix ? `${prefix}${n}` : `${n}`
        if (!r && external?.material_url) {
          out.push(
            <button
              key={`${kp}-cite${i}-${idx}`}
              type="button"
              className="cite cite-external"
              title={external.title ?? external.material_url}
              aria-label={`External citation ${n}: ${external.title ?? external.material_url}`}
              onClick={() =>
                ctx.onClickCitation?.({
                  materialId: external.material_id,
                  chunkId: external.chunk_id,
                  title: external.title,
                  materialUrl: external.material_url,
                })
              }
              style={{
                border: 'none',
                cursor: ctx.onClickCitation ? 'pointer' : 'default',
                fontFamily: 'inherit',
              }}
            >
              {label}
            </button>,
          )
          return
        }
        if (!r || (!r.material_id && !r.material_url)) {
          out.push(
            <span
              key={`${kp}-cite${i}-${idx}`}
              className="cite cite-missing"
              title="Source unavailable"
              aria-label={`Citation ${label} source unavailable`}
            >
              {label}
            </span>,
          )
          return
        }
        out.push(
          <button
            key={`${kp}-cite${i}-${idx}`}
            type="button"
            className="cite"
            title={r.title ?? `chunk ${r.chunk_id ?? '?'}`}
            aria-label={`Citation ${label}: ${r.title ?? 'Untitled source'}`}
            onClick={() =>
              ctx.onClickCitation?.({
                materialId: r.material_id,
                chunkId: r.chunk_id,
                title: r.title,
                materialUrl: r.material_url,
              })
            }
            style={{
              border: 'none',
              cursor: ctx.onClickCitation ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
        >
          {label}
        </button>,
      )
      })
    } else if (m[4]) {
      const rawHref = normalizeUrlToken(m[4])
      const href = resolveMarkdownHref(rawHref) ?? ''
      out.push(
        href ? (
          <a
            key={`${kp}-u${i}`}
            href={href}
            className="md-link"
            onClick={(e) => {
              e.preventDefault()
              void applyLinkAction(href, ctx.onLinkClick).then((blocked) => {
                if (!blocked) {
                  openInSystemBrowser(href)
                }
              })
            }}
          >
            {rawHref}
          </a>
        ) : (
          <span key={`${kp}-u${i}`}>{rawHref}</span>
        ),
      )
    } else if (m[5] !== undefined) {
      // Bold — recurse so nested *italic* / `code` inside renders.
      out.push(
        <strong key={`${kp}-b${i}`}>
          {renderInline(m[5], ctx, `${kp}-b${i}`, depth + 1)}
        </strong>,
      )
    } else if (m[6] !== undefined) {
      // Italic — recurse so nested `code` inside renders.
      out.push(
        <em key={`${kp}-i${i}`}>
          {renderInline(m[6], ctx, `${kp}-i${i}`, depth + 1)}
        </em>,
      )
    }
    last = m.index + tok.length
    i++
  }
  if (last < text.length) {
    out.push(<span key={`${kp}-tend`}>{text.slice(last)}</span>)
  }
  return out
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/
const HR_RE = /^(\*{3,}|-{3,}|_{3,})$/
const FENCE_RE = /^```/
const QUOTE_RE = /^>\s?/

// GFM table: a header row, a `|---|:--:|` separator row, then body
// rows. Cells are pipe-delimited with optional outer pipes; the
// separator row's `:` markers set per-column alignment.
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/

type CellAlign = 'left' | 'center' | 'right'

function splitTableRow(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function parseTableAligns(sep: string): CellAlign[] {
  return splitTableRow(sep).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

// A table starts where line `i` carries a pipe and line `i+1` is a
// `|---|` separator — both conditions guard against false positives
// (a lone `|` in prose isn't a table).
function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i].includes('|') &&
    lines[i].trim() !== '' &&
    lines[i + 1].includes('-') &&
    TABLE_SEP_RE.test(lines[i + 1])
  )
}

/**
 * Parse `text` as Markdown and return a React fragment of block
 * elements. Pass it the turn's `retrieved` list + `onClickCitation`
 * so `[N]` markers stay clickable.
 */
export function Markdown({
  text,
  retrieved,
  onClickCitation,
  onLinkClick,
}: {
  text: string
  retrieved: RetrievedRef[]
  onClickCitation?: (detail: CitationClick) => void
  onLinkClick?: Ctx['onLinkClick']
}): ReactNode {
  const ctx: Ctx = { retrieved, onClickCitation, onLinkClick }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let bi = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Fenced code block.
    if (FENCE_RE.test(trimmed)) {
      i++
      const code: string[] = []
      while (i < lines.length && lines[i].trim() !== '```') {
        code.push(lines[i])
        i++
      }
      i++ // consume closing fence (if present)
      const codeText = code.join('\n')
      blocks.push(
        <div key={`b${bi++}`} className="md-pre-wrap">
          <CodeCopyButton codeText={codeText} idPrefix={`b${bi - 1}`} />
          <pre className="md-pre">
            <code>{codeText}</code>
          </pre>
        </div>,
      )
      continue
    }

    // Blank line — block separator.
    if (trimmed === '') {
      i++
      continue
    }

    // Heading.
    const h = HEADING_RE.exec(line)
    if (h) {
      const level = h[1].length
      // # / ## → h3 (the reply itself is body text, so a top-level
      // heading shouldn't claim h1/h2); deeper levels step down.
      const tag = (
        level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5'
      ) as 'h3' | 'h4' | 'h5'
      const Tag = tag
      blocks.push(
        <Tag key={`b${bi++}`} className="md-h">
          {renderInline(h[2], ctx, `h${bi}`)}
        </Tag>,
      )
      i++
      continue
    }

    // Horizontal rule.
    if (HR_RE.test(trimmed)) {
      blocks.push(<hr key={`b${bi++}`} className="md-hr" />)
      i++
      continue
    }

    // Blockquote — gather consecutive `>` lines.
    if (QUOTE_RE.test(line)) {
      const quote: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quote.push(lines[i].replace(QUOTE_RE, ''))
        i++
      }
      blocks.push(
        <blockquote key={`b${bi++}`} className="md-quote">
          {renderInline(quote.join(' '), ctx, `bq${bi}`)}
        </blockquote>,
      )
      continue
    }

    // List — gather consecutive item lines. Ordered-ness is decided
    // by the first item; a single indent level is honoured via a
    // left margin (no nested <ul> trees).
    if (LIST_RE.test(line)) {
      const items: { indent: number; content: string }[] = []
      let ordered = false
      let first = true
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const lm = LIST_RE.exec(lines[i])!
        if (first) {
          ordered = /\d+\./.test(lm[2])
          first = false
        }
        items.push({ indent: lm[1].length, content: lm[3] })
        i++
      }
      const ListTag = (ordered ? 'ol' : 'ul') as 'ol' | 'ul'
      blocks.push(
        <ListTag key={`b${bi++}`} className="md-list">
          {items.map((it, k) => (
            <li
              key={k}
              style={it.indent >= 2 ? { marginLeft: 16 } : undefined}
            >
              {renderInline(it.content, ctx, `li${bi}-${k}`)}
            </li>
          ))}
        </ListTag>,
      )
      continue
    }

    // Table — a header row + a `|---|` separator row, then body rows.
    // The header fixes the column count: extra body cells are dropped,
    // missing ones render empty (GFM behaviour).
    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i])
      const aligns = parseTableAligns(lines[i + 1])
      i += 2
      const rows: string[][] = []
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        lines[i].includes('|') &&
        !FENCE_RE.test(lines[i].trim())
      ) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      const tIdx = bi
      blocks.push(
        <table key={`b${bi++}`} className="md-table">
          <thead>
            <tr>
              {header.map((cell, c) => (
                <th key={c} style={{ textAlign: aligns[c] ?? 'left' }}>
                  {renderInline(cell, ctx, `th${tIdx}-${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {header.map((_, c) => (
                  <td key={c} style={{ textAlign: aligns[c] ?? 'left' }}>
                    {renderInline(row[c] ?? '', ctx, `td${tIdx}-${r}-${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    // Paragraph — gather consecutive lines that aren't another block
    // type. Intra-paragraph newlines become <br> so the model's line
    // breaks are preserved (chat users expect that over Markdown's
    // collapse-to-space rule).
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_RE.test(lines[i].trim()) &&
      !HEADING_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i].trim()) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i])
      i++
    }
    const pIdx = bi
    blocks.push(
      <p key={`b${bi++}`} className="md-p">
        {para.map((ln, k) => (
          <span key={k}>
            {k > 0 && <br />}
            {renderInline(ln, ctx, `p${pIdx}-${k}`)}
          </span>
        ))}
      </p>,
    )
  }

  return <>{blocks}</>
}
