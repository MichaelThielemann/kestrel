import { describe, it, expect } from 'vitest'
import { compilePublishableRedirects, compileRedirects, matchRedirect, patternToRegexSource, serializeRedirects } from './redirect-rules'

const row = (from: string, to: string, status = '301') => ({ from, to, status })

// The emitted capture classes, spelled out once. They exclude a backslash and control characters
// everywhere, and a leading slash from a multi-segment capture — see the security block at the bottom
// for WHY, and assert the behaviour there rather than trusting these strings.
const SEG = '[^/\\\\\\x00-\\x1f\\x7f]'
const ANY = '[^\\\\\\x00-\\x1f\\x7f]'
const ONE = `(${SEG}+)`
const MANY = `(${SEG}${ANY}*?)`

describe('patternToRegexSource', () => {
  it('anchors a literal path and escapes regex metacharacters', () => {
    expect(patternToRegexSource('/alte-seite')).toBe('^/alte\\-seite/?$')
    expect(patternToRegexSource('/a.b/c(d)+e')).toBe('^/a\\.b/c\\(d\\)\\+e/?$')
  })

  it('adds the leading slash a relative path omits', () => {
    expect(patternToRegexSource('alte-seite')).toBe('^/alte\\-seite/?$')
  })

  it('drops an authored trailing slash and tolerates one at match time', () => {
    expect(patternToRegexSource('/blog/')).toBe('^/blog/?$')
    expect(patternToRegexSource('/')).toBe('^/$')
  })

  it('translates `*` to a single path segment', () => {
    expect(patternToRegexSource('/blog/*')).toBe(`^/blog/${ONE}/?$`)
  })

  it('translates `**` to one or more segments', () => {
    expect(patternToRegexSource('/blog/**')).toBe(`^/blog/${MANY}/?$`)
  })

  it('supports several wildcards, in authored order', () => {
    expect(patternToRegexSource('/*/blog/*')).toBe(`^/${ONE}/blog/${ONE}/?$`)
    expect(patternToRegexSource('/*/archiv/**')).toBe(`^/${ONE}/archiv/${MANY}/?$`)
  })

  it('treats a wildcard inside a segment as that segment fragment', () => {
    expect(patternToRegexSource('/artikel-*.html')).toBe(`^/artikel\\-${ONE}\\.html/?$`)
  })
})

describe('compileRedirects', () => {
  it('turns rows into the flat artifact shape, status as a number', () => {
    expect(compileRedirects([row('/blog/*', '/artikel/$1'), row('/alte-seite', '/neue-seite', '302')])).toEqual([
      { pattern: `^/blog/${ONE}/?$`, target: '/artikel/$1', status: 301 },
      { pattern: '^/alte\\-seite/?$', target: '/neue-seite', status: 302 },
    ])
  })

  it('preserves row order — order is priority', () => {
    const rules = compileRedirects([row('/a', '/1'), row('/b', '/2'), row('/c', '/3')])
    expect(rules.map((r) => r.target)).toEqual(['/1', '/2', '/3'])
  })

  it('accepts every supported status', () => {
    const rules = compileRedirects([row('/a', '/1', '301'), row('/b', '/2', '302'), row('/c', '/3', '307'), row('/d', '/4', '308')])
    expect(rules.map((r) => r.status)).toEqual([301, 302, 307, 308])
  })

  it('defaults a missing status to 301', () => {
    expect(compileRedirects([{ from: '/a', to: '/b' }])[0]!.status).toBe(301)
  })

  it('treats an empty, null or undefined field value as zero redirects', () => {
    expect(compileRedirects([])).toEqual([])
    expect(compileRedirects(null)).toEqual([])
    expect(compileRedirects(undefined)).toEqual([])
  })

  it('adds the leading slash a relative target omits', () => {
    expect(compileRedirects([row('/a', 'neue-seite')])[0]!.target).toBe('/neue-seite')
  })

  it('keeps an absolute http(s) target verbatim', () => {
    expect(compileRedirects([row('/a', 'https://neu.example.com/x?q=1')])[0]!.target).toBe('https://neu.example.com/x?q=1')
    expect(compileRedirects([row('/blog/*', 'https://neu.example.com/artikel/$1')])[0]!.target)
      .toBe('https://neu.example.com/artikel/$1')
  })

  it('rejects a target with a non-http scheme or no host', () => {
    expect(() => compileRedirects([row('/a', 'javascript:alert(1)')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/a', 'ftp://example.com/x')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/a', '//evil.example.com/x')])).toThrow(/Row 1/)
  })

  it('rejects a source that carries a query, fragment, backslash or traversal', () => {
    expect(() => compileRedirects([row('/a?x=1', '/b')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/a#top', '/b')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/a\\b', '/b')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/a/../b', '/c')])).toThrow(/Row 1/)
  })

  it('rejects a source that carries a scheme or host — matching is path-only', () => {
    expect(() => compileRedirects([row('https://alt.example.com/a', '/b')])).toThrow(/Row 1/)
  })

  it('rejects an unsupported status', () => {
    expect(() => compileRedirects([row('/a', '/b', '303')])).toThrow(/Row 1/)
  })

  it('names the offending row in the message', () => {
    expect(() => compileRedirects([row('/ok', '/fine'), row('/a?x=1', '/b')])).toThrow(/Row 2/)
  })

  it('rejects a target placeholder with no matching wildcard', () => {
    expect(() => compileRedirects([row('/blog/*', '/artikel/$2')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/blog', '/artikel/$1')])).toThrow(/Row 1/)
  })

  it('rejects a row whose source or target is blank', () => {
    expect(() => compileRedirects([row('   ', '/b')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/a', '')])).toThrow(/Row 1/)
  })

  it('ignores unknown row keys rather than failing the save', () => {
    expect(compileRedirects([{ from: '/a', to: '/b', status: '301', note: 'x' }])).toEqual([
      { pattern: '^/a/?$', target: '/b', status: 301 },
    ])
  })
})

describe('serializeRedirects', () => {
  it('serializes an empty list to a valid, non-empty JSON document', () => {
    expect(serializeRedirects([])).toBe('[]')
  })

  it('emits the documented artifact shape', () => {
    expect(JSON.parse(serializeRedirects(compileRedirects([row('/blog/*', '/artikel/$1')])))).toEqual([
      { pattern: `^/blog/${ONE}/?$`, target: '/artikel/$1', status: 301 },
    ])
  })
})

describe('matchRedirect', () => {
  const rules = compileRedirects([
    row('/blog/*', '/artikel/$1'),
    row('/blog/**', '/archiv/$1', '302'),
    row('/*/shop/*', '/$1/laden/$2', '308'),
  ])

  it('returns the first matching rule, not the most specific one', () => {
    expect(matchRedirect(rules, '/blog/hallo')).toEqual({ target: '/artikel/hallo', status: 301 })
  })

  it('falls through to a later rule when the earlier one does not match', () => {
    expect(matchRedirect(rules, '/blog/2024/hallo')).toEqual({ target: '/archiv/2024/hallo', status: 302 })
  })

  it('substitutes several placeholders positionally', () => {
    expect(matchRedirect(rules, '/de/shop/schuhe')).toEqual({ target: '/de/laden/schuhe', status: 308 })
  })

  it('tolerates a trailing slash on the request path', () => {
    expect(matchRedirect(rules, '/blog/hallo/')).toEqual({ target: '/artikel/hallo', status: 301 })
  })

  it('returns null when nothing matches', () => {
    expect(matchRedirect(rules, '/impressum')).toBeNull()
  })

  it('returns null for an empty rule list', () => {
    expect(matchRedirect([], '/blog/hallo')).toBeNull()
  })

  it('substitutes into an absolute target too', () => {
    const abs = compileRedirects([row('/blog/*', 'https://neu.example.com/artikel/$1')])
    expect(matchRedirect(abs, '/blog/hallo')).toEqual({ target: 'https://neu.example.com/artikel/hallo', status: 301 })
  })
})

// A capture is attacker-supplied: it comes from the request path, not from the editor. `normalizeTarget`
// can only vouch for the authored literal, so the PATTERN has to be the guard — a request that would
// splice something dangerous into `Location` must simply not match, and fall through to the origin.
describe('captures cannot break out of the target', () => {
  it('a backslash segment does not match — browsers resolve `/\\host` as `//host`', () => {
    const rules = compileRedirects([row('/*/shop/*', '/$1/laden/$2')])
    expect(matchRedirect(rules, '/\\evil.example.com/shop/x')).toBeNull()
    expect(matchRedirect(rules, '/de/shop/\\evil.example.com')).toBeNull()
  })

  it('a `**` capture may not start with a slash — `/$1` would become a protocol-relative `//host`', () => {
    const rules = compileRedirects([row('/blog/**', '/$1')])
    expect(matchRedirect(rules, '/blog//evil.example.com')).toBeNull()
    expect(matchRedirect(rules, '/blog/2024/hallo')).toEqual({ target: '/2024/hallo', status: 301 })
  })

  it('a CR/LF segment does not match — it would split the Location header', () => {
    const rules = compileRedirects([row('/blog/*', '/artikel/$1')])
    expect(matchRedirect(rules, '/blog/x\r\nSet-Cookie: a=b')).toBeNull()
    expect(matchRedirect(rules, '/blog/x\u0000y')).toBeNull()
  })

  it('every capture that does match resolves against the site, never off it', () => {
    const rules = compileRedirects([row('/*/shop/*', '/$1/laden/$2'), row('/blog/**', '/archiv/$1')])
    for (const path of ['/\\evil.example.com/shop/x', '/blog//evil.example.com', '/blog/x\r\nx']) {
      const hit = matchRedirect(rules, path)
      if (hit) expect(new URL(hit.target, 'https://kunde.example').origin).toBe('https://kunde.example')
    }
  })

  it('rejects a placeholder that would land in an absolute target host', () => {
    expect(() => compileRedirects([row('/blog/*', 'https://neu.example.com$1')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/blog/*', 'https://$1.example.com/x')])).toThrow(/Row 1/)
    expect(compileRedirects([row('/blog/*', 'https://neu.example.com/$1')])[0]!.target)
      .toBe('https://neu.example.com/$1')
  })

  it('rejects `${n}`, which would otherwise ship verbatim in every Location', () => {
    expect(() => compileRedirects([row('/blog/*', '/artikel/${1}')])).toThrow(/Row 1/)
    expect(() => compileRedirects([row('/blog/*', '/artikel/${}')])).toThrow(/Row 1/)
  })

  it('leaves a literal `$` alone — it is a legal path character', () => {
    expect(compileRedirects([row('/a', '/preise/ab$')])[0]!.target).toBe('/preise/ab$')
    expect(compileRedirects([row('/a', '/x?q=a$b')])[0]!.target).toBe('/x?q=a$b')
  })

  it('rejects two adjacent `**`, which match the same thing at quadratic cost', () => {
    expect(() => compileRedirects([row('/**/**/end', '/$1/$2')])).toThrow(/Row 1/)
    expect(compileRedirects([row('/**/archiv/**', '/$1/$2')])[0]!.target).toBe('/$1/$2')
  })
})

describe('compilePublishableRedirects', () => {
  it('compiles a clean set exactly like the strict compiler', () => {
    const { rules, skipped } = compilePublishableRedirects([row('/a', '/b'), row('/blog/*', '/artikel/$1')])
    expect(rules).toEqual(compileRedirects([row('/a', '/b'), row('/blog/*', '/artikel/$1')]))
    expect(skipped).toEqual([])
  })

  it('drops a row this version can no longer compile instead of failing the whole artifact', () => {
    // The save path rejects such a row (see the collection's `validate`), so the only way one is stored
    // is a Kestrel upgrade that tightened the rules. Publishing the rest beats publishing nothing.
    const { rules, skipped } = compilePublishableRedirects([row('/a', '/b'), row('/x', '/y/${1}'), row('/c', '/d')])
    expect(rules.map((r) => r.target)).toEqual(['/b', '/d'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatch(/Row 2/)
  })

  it('treats an absent rule list as zero redirects, not as an error', () => {
    expect(compilePublishableRedirects(null)).toEqual({ rules: [], skipped: [] })
  })

  it('still throws when the rows are not a list at all — that is a read bug, not a bad row', () => {
    expect(() => compilePublishableRedirects('nope')).toThrow()
  })
})
