import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const SELF = resolve(root, 'test/architecture/vocabulary-hygiene.test.ts')

/** Path prefixes excluded from the scan: generated output, third-party lockfiles, and generated API docs. */
const EXCLUDED_PREFIXES = ['graphify-out/', 'dist/', 'node_modules/']
/** The hygiene rails whose banned-pattern regexes are the ban itself; their source is the one place the
 *  patterns may appear. */
const EXCLUDED_FILES = new Set([
  'pnpm-lock.yaml',
  'test/architecture/comment-hygiene.test.ts',
  'test/architecture/docs-hygiene.test.ts',
])
const EXCLUDED_DIRS = ['docs/api/']

/** Every tracked text file, git-discovered so a new file is covered the moment it is committed. Binary
 *  files are skipped via `git grep -I`'s own binary detection, replicated here with a null-byte sniff. */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  return out.split('\n').filter(Boolean).filter((f) =>
    !EXCLUDED_PREFIXES.some((p) => f.startsWith(p))
    && !EXCLUDED_DIRS.some((p) => f.startsWith(p))
    && !EXCLUDED_FILES.has(f)
    && resolve(root, f) !== SELF,
  )
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

/** Internal work-program vocabulary that must never reach a tracked file. `\bW\d+…` excludes W3C/WCAG by
 *  requiring digits right after the W. */
const BANNED: RegExp[] = [
  /\bW\d+(\.\d+)*[a-z]?(-\d+)?\b/,
  /\bR ?\d+\.\d+\b/,
  /rulebook/i,
  /this program\b/i,
  /fix round/i,
  /USER DIRECTIVE/,
  /Regelwerk/i,
]

interface Violation { file: string; line: number; text: string }

function findViolations(files: string[]): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    const buf = readFileSync(resolve(root, file))
    if (isBinary(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    lines.forEach((line, i) => {
      if (/W3C|WCAG/.test(line)) {
        // Strip the allowed terms before testing, so a line naming W3C/WCAG alongside an unrelated
        // W-item tag is still caught.
        const stripped = line.replace(/W3C|WCAG/g, '')
        if (BANNED.some((re) => re.test(stripped))) out.push({ file, line: i + 1, text: line.trim() })
        return
      }
      if (BANNED.some((re) => re.test(line))) out.push({ file, line: i + 1, text: line.trim() })
    })
  }
  return out
}

describe('tracked files stay free of internal work-program vocabulary', () => {
  const files = trackedTextFiles()

  it('sanity: tracked files are discovered (the scan itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('no tracked file (source, docs, config, or test) contains a W-item tag, an R-rule tag, or a banned phrase', () => {
    const violations = findViolations(files)
    expect(
      violations,
      violations.map((v) => `${v.file}:${v.line}: ${JSON.stringify(v.text.length > 200 ? `${v.text.slice(0, 200)}…` : v.text)}`).join('\n')
      || undefined,
    ).toEqual([])
  })
})
