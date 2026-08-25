import { fieldIs } from '@kestrel/core'
import type { CollectionDef, FieldDef } from '@kestrel/core'
import { getBlock } from '@kestrel/fields'
import { resolveRichtextLinks } from '@kestrel/core/client'
import { escapeMarkdownBlock, richtextToMarkdown } from './richtext-markdown.js'

/** One published page rendered in full: what `llms.txt` links to, plus the body it links to. */
/** @public */
export interface LlmsFullPage {
  title: string
  url: string
  description?: string
  /** Markdown; already heading-shifted to nest under the page's own `###`. */
  body: string
}

/** A titled group of pages — one `## heading` block, mirroring `llms.txt`'s sections. */
/** @public */
export interface LlmsFullSection {
  heading: string
  pages: LlmsFullPage[]
}

/** Pages sit at `###`, so a body's own `<h1>` has to start at `####` to keep the outline valid. */
/** @public */
export const LLMS_FULL_HEADING_OFFSET = 3

// Same defence as `llms.txt`: a title, heading or description is editor-authored text, and a newline in
// it would forge a second document line — here, a heading that invents a page.
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Render an `llms-full.txt` (the long form of https://llmstxt.org): the site header, then every
 * published, indexable page's full Markdown body under its own `###` heading, grouped by collection.
 * Where `llms.txt` is a map, this is the territory — one document an answer engine can retrieve without
 * crawling. Pure + deterministic; the route feeds it published, indexable pages only.
 * @public
 */
export function buildLlmsFullTxt(opts: { siteName: string; siteDescription?: string; sections: LlmsFullSection[] }): string {
  const blocks: string[] = [`# ${oneLine(opts.siteName)}`]
  // A description is a whole block of its own, so flattening its newlines is not enough — a leading `##`
  // would still open a section beside the ones this generator writes.
  if (opts.siteDescription) blocks.push(`> ${escapeMarkdownBlock(oneLine(opts.siteDescription))}`)
  for (const section of opts.sections) {
    if (!section.pages.length) continue
    blocks.push(`## ${oneLine(section.heading)}`)
    for (const page of section.pages) {
      blocks.push(`### ${oneLine(page.title)}`)
      blocks.push(`Source: ${page.url}`)
      if (page.description) blocks.push(escapeMarkdownBlock(oneLine(page.description)))
      if (page.body) blocks.push(page.body)
    }
  }
  return `${blocks.join('\n\n')}\n`
}

/** @public */
export interface RecordMarkdownOptions {
  /** Push every body heading down by this many levels — see `LLMS_FULL_HEADING_OFFSET`. */
  headingOffset?: number
  /** Top-level field keys the caller already rendered (the title it used as the heading). */
  skipFields?: string[]
  /** `kestrel:<collection>:<id>` → absolute URL, or null for a target that must not be linked (a draft,
   *  a noindexed page, a non-routable record). Unresolved links keep their text and lose the anchor. */
  resolveLink?: (collection: string, id: number) => string | null
}

/** The prose in one flat value bag (record columns | block props | a repeater entry), in field order.
 *  Only `text` and `richtext` carry prose; `repeater` recurses. Everything else is data, not content —
 *  a consumer's own field type is skipped rather than guessed at. */
function bagMarkdown(fields: Record<string, FieldDef>, bag: Record<string, unknown>, opts: RecordMarkdownOptions, skip?: Set<string>): string[] {
  const out: string[] = []
  for (const [key, field] of Object.entries(fields)) {
    if (skip?.has(key)) continue
    const value = bag[key]
    if (field.type === 'text') {
      // `fieldIs` rather than a switch: the open consumer-type arm makes `type` a non-discriminant, so a
      // switch would not narrow (the same reason `extract-refs` walks this way).
      // A text field is raw editor input with no markup to constrain it, so it is the one value that
      // reaches the document verbatim — it needs the same block-marker escaping converted prose gets.
      const text = typeof value === 'string' ? value.trim() : ''
      if (text) out.push(escapeMarkdownBlock(text))
    } else if (field.type === 'richtext') {
      // Always run the marker rewrite, resolver or not: an unrewritten `kestrel:<coll>:<id>` href would
      // ship a private storage token as a link target. With no resolver every marker declines to `#`,
      // which the converter renders as plain text.
      const html = typeof value === 'string' ? resolveRichtextLinks(value, opts.resolveLink ?? (() => null)) : ''
      const md = richtextToMarkdown(html, { headingOffset: opts.headingOffset })
      if (md) out.push(md)
    } else if (fieldIs(field, 'repeater')) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object') out.push(...bagMarkdown(field.options.fields, entry as Record<string, unknown>, opts))
        }
      }
    }
  }
  return out
}

/** The prose in a block `content` array, recursing slots — the same walk `extract-refs` does for refs. */
function blockMarkdown(content: unknown, opts: RecordMarkdownOptions): string[] {
  const out: string[] = []
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const n = node as { type?: string; props?: Record<string, unknown>; slots?: Record<string, unknown> }
      // An unregistered block type has no field defs, so there is no way to tell its prose from its
      // configuration — emitting every string prop would put layout tokens into the document.
      const def = n.type ? getBlock(n.type) : undefined
      if (def && n.props && typeof n.props === 'object') out.push(...bagMarkdown(def.fields, n.props, opts))
      if (n.slots && typeof n.slots === 'object') for (const slotNodes of Object.values(n.slots)) walk(slotNodes)
    }
  }
  walk(content)
  return out
}

/**
 * A record's readable content as Markdown: its own text/richtext fields (in declaration order), then its
 * block tree if the collection enables blocks. Pure apart from the block registry — the same dependency
 * `extractRecordRefs` has, and for the same reason: a block's prose is only identifiable through its
 * registered field defs.
 * @public
 */
export function recordMarkdown(def: CollectionDef, row: Record<string, unknown>, opts: RecordMarkdownOptions = {}): string {
  const blocks = bagMarkdown(def.fields, row, opts, opts.skipFields?.length ? new Set(opts.skipFields) : undefined)
  if (def.blocks?.enabled) blocks.push(...blockMarkdown(row.content, opts))
  return blocks.join('\n\n')
}
