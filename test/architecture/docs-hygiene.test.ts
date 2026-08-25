import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const root = process.cwd()

function mdFiles(dir: string): string[] {
  const abs = resolve(root, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs).flatMap((name) => {
    const p = join(abs, name)
    return statSync(p).isDirectory() ? mdFiles(join(dir, name)) : name.endsWith('.md') ? [join(dir, name)] : []
  })
}

const ALL = ['README.md', 'SECURITY.md', ...mdFiles('docs/guide'), ...mdFiles('docs/internals')]
const GUIDE = mdFiles('docs/guide')

/** Internal work-program vocabulary that must not reach a reader. */
const FORBIDDEN: RegExp[] = [
  /\bW\d+(\.\d+)*[a-z]?\b/, /\bR \d+\.\d+\b/, /rulebook/i, /adopted architecture plan/i, /this program\b/i,
  /USER DIRECTIVE/, /\bPhase \d/, /fix round/i, /FEATURES /, /\bpilot\b/i, /\bn ?= ?1\b/, /Pruvious/,
  /Keep-on-doubt/i, /4\.0 break/, /v1 scope/i, /pre-existing/i,
]

/** The guide names exported API only — never a source path or a decision record. */
const GUIDE_FORBIDDEN: RegExp[] = [/ADR-\d{4}/, /packages\/kestrel-[a-z-]+\/src\//, /layers\/[a-z-]+\/server\//]

/** Fenced code is example material, not prose. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, '')

/** GitHub's heading → anchor slug. */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/ /g, '-')
}

function headings(md: string): Set<string> {
  return new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])))
}

describe('docs hygiene', () => {
  it.each(ALL)('%s carries no internal program vocabulary', (file) => {
    const text = prose(readFileSync(resolve(root, file), 'utf8'))
    expect(FORBIDDEN.filter((re) => re.test(text)).map(String)).toEqual([])
  })

  if (GUIDE.length > 0) {
    it.each(GUIDE)('%s names only public surface', (file) => {
      const text = prose(readFileSync(resolve(root, file), 'utf8'))
      expect(GUIDE_FORBIDDEN.filter((re) => re.test(text)).map(String)).toEqual([])
    })
  }

  it.each(ALL)('%s links resolve, anchors included', (file) => {
    const md = readFileSync(resolve(root, file), 'utf8')
    const broken: string[] = []
    for (const m of prose(md).matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]
      if (/^[a-z]+:/.test(href)) continue
      const [path, anchor] = href.split('#')
      const target = path ? resolve(dirname(resolve(root, file)), path) : resolve(root, file)
      if (path && !existsSync(target)) {
        broken.push(href)
        continue
      }
      if (anchor && target.endsWith('.md') && !headings(readFileSync(target, 'utf8')).has(anchor)) broken.push(href)
    }
    expect(broken).toEqual([])
  })
})
