/**
 * Richtext HTML → Markdown, for the agent-facing `llms-full.txt`. Answer engines consume Markdown, not
 * markup, and a stripped-tags dump would lose exactly the structure they retrieve on (headings, lists,
 * links).
 *
 * A hand-rolled parser rather than a DOM library because the input dialect is CLOSED and already
 * well-formed: every stored richtext value passed `sanitizeRichtext` on write, so it is sanitize-html's
 * own re-serialization of a parsed tree, restricted to `RICHTEXT_ALLOWLIST`. That keeps this pure — no
 * DOM, no Nuxt, no new dependency in the public layer's server bundle — so it unit-tests hard.
 *
 * Deliberately minimal escaping: only link text (whose brackets would break the link syntax) and a
 * leading block marker (which would silently turn a paragraph into a list item or heading). Escaping
 * every markdown metacharacter would make the output markedly harder to read for the model that reads it.
 */

/** @public */
export interface RichtextMarkdownOptions {
  /** Push every heading down by this many levels (clamped at h6), so a body nests under the document
   *  headings the caller already emitted. */
  headingOffset?: number
}

type MdNode =
  | { kind: 'text'; value: string }
  | { kind: 'el'; tag: string; attrs: Record<string, string>; children: MdNode[] }

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link'])
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
const BLOCK_TAGS = new Set(['p', 'blockquote', 'pre', 'ul', 'ol', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const TAG = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/)?>/g
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/** Decode the entity set sanitize-html emits, plus numeric references. `&nbsp;` becomes an ordinary
 *  space on purpose: a U+00A0 survives whitespace collapsing and shows up as a stray gap. */
function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!raw.trim()) return attrs
  ATTR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR.exec(raw))) {
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attrs
}

/** Tag soup → a node tree. A stray close tag with no matching open is dropped; anything still open at
 *  the end is closed implicitly, so a truncated value degrades to the content it did carry. */
function parse(html: string): MdNode[] {
  const root: MdNode[] = []
  const stack: Array<{ tag: string; children: MdNode[] }> = []
  const top = (): MdNode[] => (stack.length ? stack[stack.length - 1]!.children : root)
  const pushText = (raw: string): void => {
    if (raw) top().push({ kind: 'text', value: decodeEntities(raw) })
  }

  TAG.lastIndex = 0
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(html))) {
    pushText(html.slice(cursor, m.index))
    cursor = TAG.lastIndex
    const tag = m[2]!.toLowerCase()
    if (m[1]) {
      // Close the innermost matching element; an unmatched close tag is ignored rather than unwinding
      // the whole stack, which would drop every sibling that followed it.
      const at = stack.map((s) => s.tag).lastIndexOf(tag)
      if (at >= 0) stack.length = at
      continue
    }
    const node: MdNode = { kind: 'el', tag, attrs: parseAttrs(m[3] ?? ''), children: [] }
    top().push(node)
    if (!m[4] && !VOID_TAGS.has(tag)) stack.push({ tag, children: node.children })
  }
  pushText(html.slice(cursor))
  return root
}

/** Raw text of a subtree, entities already decoded and whitespace untouched (code blocks). */
function rawText(nodes: MdNode[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.value : rawText(n.children))).join('')
}

const escapeLinkText = (s: string): string => s.replace(/[[\]]/g, '\\$&')

const INLINE_WRAP: Record<string, string> = { strong: '**', b: '**', em: '*', i: '*', s: '~~' }

/** The longest run of `char` anywhere in `text` — the width a fence/delimiter has to beat to contain it. */
function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const c of text) {
    run = c === char ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/** Inline code with a backtick delimiter wider than any backtick run inside it (CommonMark's own escape
 *  hatch), padded with a space when the content would otherwise fuse with the delimiter. */
function inlineCode(text: string): string {
  const delimiter = '`'.repeat(longestRun(text, '`') + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${delimiter}${pad}${text}${pad}${delimiter}`
}

function renderInline(nodes: MdNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') { out += node.value.replace(/\s+/g, ' '); continue }
    if (node.tag === 'br') { out += '\n'; continue }
    if (node.tag === 'a') {
      const text = renderInline(node.children).trim()
      const href = node.attrs.href
      // `#` is what the internal-link resolver writes for a target it declined (missing or unpublished) —
      // a dead anchor is worth less than the words it wraps, so keep the words and drop the link.
      out += !href || href === '#' ? text : `[${escapeLinkText(text)}](${href})`
      continue
    }
    const inner = renderInline(node.children)
    if (node.tag === 'code') { out += inner.trim() ? inlineCode(inner.trim()) : inner; continue }
    const wrap = INLINE_WRAP[node.tag]
    if (!wrap || !inner.trim()) { out += inner; continue }
    // CommonMark will not open emphasis on `** bold **` — whitespace immediately inside the delimiter
    // makes it literal asterisks. Editors leave it there routinely (selecting a word plus its space), so
    // move it outside rather than emitting markup that does not parse.
    const [, lead = '', body = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? []
    out += `${lead}${wrap}${body}${wrap}${trail}`
  }
  return out
}

const prefixLines = (text: string, first: string, rest: string): string =>
  text.split('\n').map((line, i) => (i === 0 ? first + line : (line ? rest + line : rest.trimEnd()))).join('\n')

/** Escape a line that would otherwise open a Markdown block: a heading, a list item, a quote, a code
 *  fence or a thematic break. One backslash on the first marker character defuses all of them (every one
 *  is ASCII punctuation, so the escape is valid CommonMark and renders as the literal character). */
function escapeMarkerLine(line: string): string {
  // CommonMark allows a block marker up to three spaces in; deeper is an indented code block, which no
  // backslash can defuse — and which whitespace collapsing has already removed from converted text.
  const [, indent = '', rest = ''] = /^(\s{0,3})([\s\S]*)$/.exec(line) ?? []
  const ordered = /^(\d{1,9})[.)](\s|$)/.exec(rest)
  if (ordered) return `${indent}${ordered[1]}\\${rest.slice(ordered[1]!.length)}`
  const opensBlock = /^#{1,6}(\s|$)/.test(rest)          // heading, any level
    || /^[-+*](\s|$)/.test(rest)                          // bullet list
    || rest.startsWith('>')                               // block quote
    || /^(`{3,}|~{3,})/.test(rest)                        // fenced code
    || /^([-*_])[\s]*(\1[\s]*){2,}$/.test(rest)           // thematic break (and the setext h2 underline)
    || /^=+\s*$/.test(rest)                               // setext h1 underline
  return opensBlock ? `${indent}\\${rest}` : line
}

/**
 * Escape every line of a text block that would open a Markdown construct. Applied per LINE, not once per
 * block: a `<br>` becomes a real newline, so an anchored first-line-only check guards nothing after it.
 *
 * This is the whole defence between editor-authored prose and the structure of `llms-full.txt`, whose own
 * document uses `##` for collection sections and `###` for pages — an unescaped `## …` in a body would
 * not merely add a heading, it would forge a sibling of the generator's own and re-parent every page
 * after it.
 * @public
 */
export function escapeMarkdownBlock(text: string): string {
  return text.split('\n').map(escapeMarkerLine).join('\n')
}

function renderList(node: MdNode & { kind: 'el' }, opts: RichtextMarkdownOptions): string {
  const ordered = node.tag === 'ol'
  const items = node.children.filter((c): c is MdNode & { kind: 'el' } => c.kind === 'el' && c.tag === 'li')
  const lines: string[] = []
  let n = 0
  for (const item of items) {
    const blocks = renderBlocks(item.children, opts)
    n += 1
    const marker = ordered ? `${n}. ` : '- '
    const indent = ' '.repeat(marker.length)
    // The first block is the item's own text; anything after it (a nested list, a second paragraph)
    // continues the item and must be indented to the marker's width to stay inside it.
    const [head = '', ...rest] = blocks
    lines.push(prefixLines(head, marker, indent))
    for (const block of rest) lines.push(prefixLines(block, indent, indent))
  }
  return lines.join('\n')
}

/** Render a node list as block-level markdown: an array of blocks, joined by a blank line by the caller. */
function renderBlocks(nodes: MdNode[], opts: RichtextMarkdownOptions): string[] {
  const blocks: string[] = []
  let run: MdNode[] = []
  const flushRun = (): void => {
    if (!run.length) return
    const text = renderInline(run).trim()
    run = []
    if (text) blocks.push(escapeMarkdownBlock(text))
  }

  for (const node of nodes) {
    // An unrecognised wrapper is transparent: splice its children into this level rather than dropping
    // the content or forcing it inline, so a consumer's stray <div>/<section> keeps its structure.
    if (node.kind === 'el' && !BLOCK_TAGS.has(node.tag) && !VOID_TAGS.has(node.tag) && !INLINE_WRAP[node.tag]
      && node.tag !== 'a' && node.tag !== 'li' && node.children.some(isBlockNode)) {
      flushRun()
      blocks.push(...renderBlocks(node.children, opts))
      continue
    }
    if (node.kind !== 'el' || !BLOCK_TAGS.has(node.tag)) { run.push(node); continue }
    flushRun()

    const level = HEADINGS[node.tag]
    if (level !== undefined) {
      // A heading is one line by definition: a `<br>` inside it would end the heading and leave the rest
      // as a bare paragraph, silently splitting the text an editor wrote as one title.
      const text = renderInline(node.children).replace(/\s+/g, ' ').trim()
      if (text) blocks.push(`${'#'.repeat(Math.min(6, level + (opts.headingOffset ?? 0)))} ${text}`)
    } else if (node.tag === 'hr') {
      blocks.push('---')
    } else if (node.tag === 'pre') {
      const code = rawText(node.children).replace(/^\n+|\n+$/g, '')
      // Fence wider than any backtick run in the code, or the code closes the fence it sits in and
      // everything after it — the rest of the page, and the pages after that — reparses as prose.
      const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1))
      if (code) blocks.push(`${fence}\n${code}\n${fence}`)
    } else if (node.tag === 'blockquote') {
      const inner = renderBlocks(node.children, opts).join('\n\n')
      if (inner) blocks.push(prefixLines(inner, '> ', '> '))
    } else if (node.tag === 'ul' || node.tag === 'ol') {
      const list = renderList(node, opts)
      if (list) blocks.push(list)
    } else {
      const text = renderInline(node.children).trim()
      if (text) blocks.push(escapeMarkdownBlock(text))
    }
  }
  flushRun()
  return blocks
}

function isBlockNode(node: MdNode): boolean {
  return node.kind === 'el' && (BLOCK_TAGS.has(node.tag) || node.tag === 'li')
}

/** Sanitized richtext HTML → Markdown. Non-string / empty input, and markup that carries no words at
 *  all, both yield `''` so a caller can drop the field without a second emptiness test. */
/** @public */
export function richtextToMarkdown(html: string | null | undefined, opts: RichtextMarkdownOptions = {}): string {
  if (typeof html !== 'string' || !html.trim()) return ''
  return renderBlocks(parse(html), opts).join('\n\n')
}
