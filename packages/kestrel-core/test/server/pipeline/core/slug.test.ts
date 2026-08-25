import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Effect } from 'effect'
import { slugify } from '../../../../src/app/utils/slugify.js'
import { decideAutoSlugBase, decideExplicitSlug, nextSlugCandidate, normalizeSlugPath, slugLocale } from '../../../../src/server/pipeline/core/slug.js'

describe('normalizeSlugPath — idempotence', () => {
  it('normalizing twice is the same as normalizing once', () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const once = normalizeSlugPath(raw)
      expect(normalizeSlugPath(once)).toBe(once)
    }), { seed: 1 })
  })

  it('always starts with a single leading slash and has no empty segments', () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const path = normalizeSlugPath(raw)
      expect(path.startsWith('/')).toBe(true)
      expect(path).not.toMatch(/\/\//)
      expect(path).not.toMatch(/[A-Z]/)
    }), { seed: 1 })
  })

  it('trims surrounding whitespace before splitting into segments', () => {
    expect(normalizeSlugPath('  /Blog/Post  ')).toBe('/blog/post')
    // A mutant that drops `.trim()` would fold the leading space into an empty first segment — still
    // filtered out — but keeps it as part of the LAST segment via `.split('/')`, surviving on inputs
    // with no slash: assert the untrimmed case directly.
    expect(normalizeSlugPath('  x  ')).toBe('/x')
  })

  it('trims a segment-internal space too, not just the whole string\'s ends (regression: this used to be non-idempotent — "! /" -> "/! " -> "/!")', () => {
    const once = normalizeSlugPath('! /')
    expect(once).toBe('/!')
    expect(normalizeSlugPath(once)).toBe(once)
  })

  it('joins segments back with a single slash, not the empty string', () => {
    expect(normalizeSlugPath('a/b/c')).toBe('/a/b/c')
  })
})

describe('decideExplicitSlug', () => {
  it('accepts the path verbatim when there is no conflict', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }).map(normalizeSlugPath), (path) => {
      expect(Effect.runSync(decideExplicitSlug({ path, conflict: null }))).toBe(path)
    }))
  })

  it('always fails with a Conflict naming the field and the rejected path', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).map(normalizeSlugPath),
      fc.record({ collection: fc.string(), id: fc.integer() }),
      (path, conflict) => {
        const exit = Effect.runSyncExit(decideExplicitSlug({ path, conflict }))
        expect(exit._tag).toBe('Failure')
        if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
          expect(exit.cause.error).toMatchObject({ field: 'path', value: path })
        }
      },
    ))
  })
})

describe('decideAutoSlugBase', () => {
  it('fails with a ValidationFailed naming the `path` field when the source has no derivable slug', () => {
    fc.assert(fc.property(fc.string().filter((s) => slugify(s) === ''), (source) => {
      const exit = Effect.runSyncExit(decideAutoSlugBase(source))
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error.issues).toEqual([{ path: ['path'], message: 'A slug is required (no title to derive one from).' }])
      }
    }))
  })

  it('succeeds with a single-leading-slash slug whenever one can be derived', () => {
    fc.assert(fc.property(fc.string().filter((s) => slugify(s) !== ''), (source) => {
      const base = Effect.runSync(decideAutoSlugBase(source))
      expect(base).toBe(`/${slugify(source)}`)
    }))
  })
})

describe('nextSlugCandidate — uniqueness-suffix monotonicity', () => {
  it('n=1 is the base itself', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), (base) => {
      expect(nextSlugCandidate(base, 1)).toBe(base)
    }))
  })

  it('every n produces a distinct candidate, strictly extending the base', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }).filter((s) => !s.includes('-')), fc.integer({ min: 2, max: 50 }), (base, n) => {
      const seen = new Set<string>()
      for (let i = 1; i <= n; i++) {
        const candidate = nextSlugCandidate(base, i)
        expect(seen.has(candidate)).toBe(false)
        seen.add(candidate)
        expect(candidate.startsWith(base)).toBe(true)
      }
    }))
  })
})

describe('slugLocale', () => {
  it('a non-translatable collection always resolves to the primary', () => {
    fc.assert(fc.property(fc.string(), fc.string(), fc.string(), (explicitLocale, existingLocale, primary) => {
      expect(slugLocale({ translatable: false, explicitLocale, existingLocale, primary })).toBe(primary)
    }))
  })

  it('an explicit locale always wins when translatable', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string(), fc.string(), (explicitLocale, existingLocale, primary) => {
      expect(slugLocale({ translatable: true, explicitLocale, existingLocale, primary })).toBe(explicitLocale)
    }))
  })

  it('falls back to existing, then primary, when no explicit locale is given', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string(), (existingLocale, primary) => {
      expect(slugLocale({ translatable: true, existingLocale, primary })).toBe(existingLocale)
      expect(slugLocale({ translatable: true, primary })).toBe(primary)
    }))
  })
})
