/** One linked resource in an llms.txt section. */
export interface LlmsEntry {
  title: string
  url: string
  /** Optional one-line summary (rendered after the link as `: description`). */
  description?: string
}

/** A titled group of resources — one `## heading` block. */
export interface LlmsSection {
  heading: string
  entries: LlmsEntry[]
}

/**
 * Render an `llms.txt` (https://llmstxt.org): an H1 site name, an optional `>` blockquote summary, then
 * one `## heading` per section listing `- [title](url): description` resources. The goal is a compact,
 * machine-readable map of the site so an AI agent grasps what it is and where the key pages live. Pure +
 * deterministic (the route feeds it published, indexable pages only); empty sections are omitted.
 */
// Collapse any whitespace (incl. newlines) to single spaces so a user-authored title/description/heading —
// which flows in from an SEO field / textarea — can't inject a spurious line into the one-per-line list.
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
// Additionally escape the brackets that would otherwise break the `[title](url)` markdown link.
const linkText = (s: string): string => oneLine(s).replace(/[[\]]/g, '\\$&')

export function buildLlmsTxt(opts: { siteName: string; siteDescription?: string; sections: LlmsSection[] }): string {
  const lines: string[] = [`# ${oneLine(opts.siteName)}`]
  if (opts.siteDescription) lines.push('', `> ${oneLine(opts.siteDescription)}`)
  for (const section of opts.sections) {
    if (!section.entries.length) continue
    lines.push('', `## ${oneLine(section.heading)}`, '')
    for (const e of section.entries) {
      const desc = e.description ? `: ${oneLine(e.description)}` : ''
      lines.push(`- [${linkText(e.title)}](${e.url})${desc}`)
    }
  }
  return `${lines.join('\n')}\n`
}
