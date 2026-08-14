/**
 * Compile the editor-authored redirect rows into the flat `redirects.json` artifact the edge consumes.
 *
 * Editors never write a regex: `from` is a path with `*` (one segment) or `**` (one or more) wildcards,
 * and `to` may reference them positionally as `$1`, `$2`, … in authored order. The translation happens
 * here — versioned, tested code — so the edge script only has to match and substitute.
 *
 * Pure by design (no Nuxt/Nitro imports): it is the executable spec for the edge as much as it is the
 * artifact writer's input, which is why `matchRedirect` lives here even though nothing in Kestrel
 * serves redirects at runtime.
 */

/** One entry of the published artifact. `pattern` is a regex SOURCE string, anchored, path-only. */
export interface RedirectRule {
  pattern: string
  target: string
  status: number
}

/** The statuses the editor offers. 301/302 cover SEO; 307/308 preserve the method on non-GET requests. */
export const REDIRECT_STATUSES = ['301', '302', '307', '308'] as const

/** A rule the editor has to fix. The message names the 1-based row so it is actionable in the UI. */
export class RedirectRuleError extends Error {}

const ESCAPE = /[.*+?^${}()|[\]\\-]/g
// eslint-disable-next-line no-control-regex -- deliberately rejects control characters headed for a Location header
const CONTROL = /[\u0000-\u001f\u007f]/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

function escapeLiteral(s: string): string {
  return s.replace(ESCAPE, '\\$&')
}

/**
 * What a wildcard may capture. This is a SECURITY boundary, not a convenience: a capture comes from the
 * request, not from the editor, so `normalizeTarget`'s checks — which only ever saw the authored literal
 * — say nothing about it. The pattern is the guard instead, and a request that would splice something
 * dangerous into `Location` simply does not match and falls through to the origin.
 *
 * Excluded everywhere: a backslash (every browser resolves `Location: /\host` as `//host` — an open
 * redirect) and the control characters that split a header (CR/LF) or terminate it (NUL, DEL).
 * Additionally, a multi-segment capture may not START with `/`, or a target of `/$1` would become the
 * protocol-relative `//host`. Anything a legitimate path contains still matches.
 */
const SEGMENT_CHAR = '[^/\\\\\\x00-\\x1f\\x7f]'
const PATH_CHAR = '[^\\\\\\x00-\\x1f\\x7f]'
const ONE_SEGMENT = `(${SEGMENT_CHAR}+)`
const MANY_SEGMENTS = `(${SEGMENT_CHAR}${PATH_CHAR}*?)`

/**
 * Translate an authored `from` into an anchored regex source. Matching is path-only and case-sensitive;
 * an authored trailing slash is dropped and one is tolerated at match time, so `/blog` and `/blog/` are
 * the same rule.
 */
export function patternToRegexSource(from: string): string {
  const raw = from.trim()
  if (!raw) throw new RedirectRuleError('"From" must not be blank')
  if (SCHEME.test(raw) || raw.startsWith('//')) {
    throw new RedirectRuleError('"From" matches the request path only — drop the scheme and host')
  }
  if (/[?#]/.test(raw)) throw new RedirectRuleError('"From" must not contain a query string or fragment')
  if (CONTROL.test(raw)) throw new RedirectRuleError('"From" must not contain control characters')
  if (raw.includes('\\')) throw new RedirectRuleError('"From" must not contain a backslash')
  if (raw.split('/').some((seg) => seg === '..')) throw new RedirectRuleError('"From" must not contain ".."')
  // Two `**` with only a separator between them match the same thing through every split point, which is
  // quadratic on a long path — seconds of CPU per request on a path an attacker chooses. It is also never
  // what the author meant, so it is an authoring error rather than a limit to tune.
  if (/\*\*\/?\*\*/.test(raw)) throw new RedirectRuleError('"From" has two `**` in a row — one already matches any number of segments')

  const path = `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`
  if (path === '/') return '^/$'

  let body = ''
  let last = 0
  for (const m of path.matchAll(/\*\*|\*/g)) {
    body += escapeLiteral(path.slice(last, m.index)) + (m[0] === '**' ? MANY_SEGMENTS : ONE_SEGMENT)
    last = m.index + m[0].length
  }
  return `^${body + escapeLiteral(path.slice(last))}/?$`
}

/** Number of capture groups `patternToRegexSource` emits for an authored `from`. */
function wildcardCount(from: string): number {
  return (from.trim().match(/\*\*|\*/g) ?? []).length
}

/**
 * Normalize an authored `to` into a `Location` value. A path gets its leading slash; an absolute
 * http(s) URL is kept verbatim (a moved domain is a legitimate target). Everything else is rejected —
 * a `javascript:`/`data:` scheme or a protocol-relative `//host` would turn a redirect into a hazard.
 */
export function normalizeTarget(to: string): string {
  const raw = to.trim()
  if (!raw) throw new RedirectRuleError('"To" must not be blank')
  if (CONTROL.test(raw)) throw new RedirectRuleError('"To" must not contain control characters')
  if (raw.includes('\\')) throw new RedirectRuleError('"To" must not contain a backslash')
  if (raw.startsWith('//')) {
    throw new RedirectRuleError('"To" must not be protocol-relative — write the full https:// URL')
  }
  if (!SCHEME.test(raw)) return `/${raw.replace(/^\/+/, '')}`

  if (!/^https?:\/\//i.test(raw)) throw new RedirectRuleError('"To" may only use http:// or https://')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RedirectRuleError(`"To" is not a valid URL: ${raw}`)
  }
  if (!url.host) throw new RedirectRuleError('"To" is missing a host')
  if (url.username || url.password) throw new RedirectRuleError('"To" must not embed credentials')
  return raw
}

/**
 * A placeholder inside an absolute target's HOST would let a visitor choose the destination
 * (`https://neu.example.com$1` + a request of `/blog/.evil.com` → `https://neu.example.com.evil.com`).
 * The capture classes cannot prevent that one — the hazard is where `$n` sits, not what it holds — so it
 * is rejected at authoring time.
 */
function assertPlaceholdersAfterHost(target: string): void {
  if (!SCHEME.test(target)) return
  const firstPlaceholder = target.indexOf('$')
  if (firstPlaceholder === -1) return
  const pathStart = target.indexOf('/', target.indexOf('://') + 3)
  if (pathStart === -1 || firstPlaceholder < pathStart) {
    throw new RedirectRuleError('"To" may only use $1, $2, … after the host — a placeholder in the host lets a visitor pick the destination')
  }
}

function readStatus(value: unknown): number {
  const s = value === undefined || value === null || value === '' ? '301' : String(value)
  if (!(REDIRECT_STATUSES as readonly string[]).includes(s)) {
    throw new RedirectRuleError(`Status must be one of ${REDIRECT_STATUSES.join(', ')} (got ${s})`)
  }
  return Number(s)
}

function readText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RedirectRuleError(`${what} must not be blank`)
  return value.trim()
}

/**
 * Rows → artifact entries, in authored order (order IS priority: the edge takes the first match).
 * An empty/absent field is zero redirects, which is a fully supported state — not an error.
 * A row the edge could not honour throws instead of being dropped, so a typo fails the save loudly.
 */
export function compileRedirects(rows: unknown): RedirectRule[] {
  if (rows === null || rows === undefined) return []
  if (!Array.isArray(rows)) throw new RedirectRuleError('Redirect rules must be a list')

  return rows.map((raw, i) => {
    try {
      const entry = (raw ?? {}) as Record<string, unknown>
      const from = readText(entry.from, '"From"')
      const target = normalizeTarget(readText(entry.to, '"To"'))
      const groups = wildcardCount(from)
      for (const [, n] of target.matchAll(/\$(\d+)/g)) {
        if (Number(n) < 1 || Number(n) > groups) {
          throw new RedirectRuleError(`"To" references $${n} but "From" has ${groups} wildcard(s)`)
        }
      }
      // `${1}` is the plausible typo — it compiles clean and then ships verbatim in every Location, a
      // rule that silently 404s. A bare `$` is left alone: it is a legal path character (RFC 3986
      // sub-delim), and only `$` followed by digits is reserved.
      if (/\$\{/.test(target)) {
        throw new RedirectRuleError('"To" writes a placeholder as $1, $2, … — not ${1}')
      }
      assertPlaceholdersAfterHost(target)
      return { pattern: patternToRegexSource(from), target, status: readStatus(entry.status) }
    } catch (err) {
      throw new RedirectRuleError(`Row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/**
 * The PUBLISHING counterpart of `compileRedirects`. Identical on data the save path accepted — which is
 * all of it, since the collection's `validate` compiles every row before the write. The difference only
 * shows after an upgrade that tightened a rule: a row stored by an older version would otherwise make
 * this artifact unrenderable forever, taking every OTHER redirect down with it (and, at build time,
 * suppressing the deploy's reconcile). Publishing the rest and naming what was dropped is the lesser
 * failure; the editor learns about it the moment they next save, which is the strict path.
 *
 * A malformed `rows` still throws: that is a read bug, not a bad row, and `[]` would be a lie.
 */
export function compilePublishableRedirects(rows: unknown): { rules: RedirectRule[]; skipped: string[] } {
  if (rows === null || rows === undefined) return { rules: [], skipped: [] }
  if (!Array.isArray(rows)) throw new RedirectRuleError('Redirect rules must be a list')

  const rules: RedirectRule[] = []
  const skipped: string[] = []
  rows.forEach((row, i) => {
    try {
      rules.push(...compileRedirects([row]))
    } catch (error) {
      skipped.push(`Row ${i + 1}: ${(error as Error).message.replace(/^Row 1: /, '')}`)
    }
  })
  return { rules, skipped }
}

/** The artifact body. An empty list is a valid document (`[]`), never an absent file. */
export function serializeRedirects(rules: RedirectRule[]): string {
  return JSON.stringify(rules)
}

/**
 * Reference implementation of the edge's match step — first rule that matches wins, `$n` substituted
 * from the capture groups. Kestrel does not serve redirects; this pins the semantics the njs handler
 * has to reproduce, and is what the tests assert against.
 */
export function matchRedirect(rules: RedirectRule[], path: string): { target: string; status: number } | null {
  for (const rule of rules) {
    const m = new RegExp(rule.pattern).exec(path)
    if (!m) continue
    return { target: rule.target.replace(/\$(\d+)/g, (_, n: string) => m[Number(n)] ?? ''), status: rule.status }
  }
  return null
}
