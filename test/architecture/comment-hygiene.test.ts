import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const SELF = resolve(root, 'test/architecture/comment-hygiene.test.ts')

/** Path prefixes excluded from the scan. `dist/`, `node_modules/`, `.desk/` (a docs dir that also holds a
 *  few tracked non-source files) and `graphify-out/` are the only ones with tracked source under them at
 *  all; `.superpowers/` is listed for the same reason the CLAUDE.md rule names it even though it is not
 *  tracked — `git ls-files` would already omit it. */
const EXCLUDED_PREFIXES = ['dist/', 'node_modules/', '.desk/', 'graphify-out/', '.superpowers/']

/** Every tracked `.ts`/`.vue`/`.mjs`/`.js` file, git-discovered so a new file is covered the moment it is
 *  committed — no hand-maintained list to fall out of date. */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', '*.ts', '*.vue', '*.mjs', '*.js'], { cwd: root, encoding: 'utf8' })
  return out.split('\n').filter(Boolean).filter((f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)))
}

/**
 * Every comment in a source file — line (`//…`), block (`/* … *‍/`), or HTML (`<!-- … -->`, for `.vue`
 * template markup) — with string literals blanked out first so a `//` or `/*` sequence sitting inside a
 * string or template literal is never mistaken for a comment opener (this is exactly why, for example, a
 * `describe('…')` test title containing a banned pattern does not trip this rail: the title is a string
 * literal, not a comment). Each string/template-literal match is replaced by same-length whitespace bounded by its
 * original quote characters, which keeps every later match index aligned with the original text so
 * comments can be sliced straight out of it.
 *
 * This is a cheap heuristic, not a parser: it does not track `${…}` interpolations inside template
 * literals, so a comment-like sequence typed inside an interpolation's own nested string could in theory
 * slip through un-blanked and be scanned as if it were code. That is an accepted false-negative risk for
 * this rail, not a soundness claim.
 */
function extractComments(text: string): string[] {
  const stringRe = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  const blanked = text.replace(stringRe, (m) => m[0] + ' '.repeat(m.length - 2) + m[m.length - 1])
  const commentRe = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g
  const out: string[] = []
  for (const m of blanked.matchAll(commentRe)) out.push(text.slice(m.index, m.index + m[0].length))
  return out
}

/** The cheap-to-check subset of the CLAUDE.md comment rule: no audit/task/ticket references in source
 *  comments. Each pattern is exactly as specified for this rail — a literal substring match is a false
 *  positive/negative risk the rail accepts in exchange for staying grep-cheap. */
const BANNED_RES: RegExp[] = [
  /\bW\d+\.\d+[a-z]?\b/,
  /fix round/i,
  /gate audit/i,
  /found by the .* audit/i,
  /reviewer/i,
  /Fixes #\d+/,
]
const BANNED_PATTERNS: Array<{ label: string; re: RegExp }> = BANNED_RES.map((re) => ({ label: re.source, re }))

interface Violation { file: string; comment: string; labels: string[] }

function findViolations(files: string[]): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    if (resolve(root, file) === SELF) continue
    const text = readFileSync(resolve(root, file), 'utf8')
    for (const comment of extractComments(text)) {
      const labels = BANNED_PATTERNS.filter(({ re }) => re.test(comment)).map(({ label }) => label)
      if (labels.length) out.push({ file, comment: comment.length > 160 ? `${comment.slice(0, 160)}…` : comment, labels })
    }
  }
  return out
}

describe('source comments stay free of audit/task/ticket references', () => {
  const files = trackedSourceFiles()

  it('sanity: tracked source files are discovered (the scan itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('no comment in a tracked .ts/.vue/.mjs/.js file carries a W-item, fix-round/gate-audit/reviewer language, or an issue ref', () => {
    const violations = findViolations(files)
    expect(
      violations,
      violations.map((v) => `${v.file}: [${v.labels.join(', ')}] ${JSON.stringify(v.comment)}`).join('\n')
      || undefined,
    ).toEqual([])
  })
})
