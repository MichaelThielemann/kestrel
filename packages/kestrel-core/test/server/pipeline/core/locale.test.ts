import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Effect } from 'effect'
import { resolveLocale, resolveUnitLocale, type LocaleConfig } from '../../../../src/server/pipeline/core/locale.js'

const config: LocaleConfig = { supported: ['en', 'de', 'fr'], primary: 'en' }

const arbSupported = fc.constantFrom(...config.supported)
const arbCasing = arbSupported.chain((locale) =>
  fc.constantFrom(locale, locale.toUpperCase(), ` ${locale} `, `  ${locale.toUpperCase()}  `),
)

describe('resolveLocale — fallback chain totality', () => {
  it('never throws: every input resolves to a success or a ValidationFailed', () => {
    fc.assert(fc.property(fc.option(fc.string(), { nil: undefined }), (value) => {
      const exit = Effect.runSyncExit(resolveLocale(config, value))
      expect(exit._tag === 'Success' || exit._tag === 'Failure').toBe(true)
    }))
  })

  it('blank/absent always falls back to the primary', () => {
    fc.assert(fc.property(fc.constantFrom(undefined, '', '  ', null), (value) => {
      expect(Effect.runSync(resolveLocale(config, value))).toBe(config.primary)
    }))
  })

  it('a supported locale resolves regardless of case/whitespace', () => {
    fc.assert(fc.property(arbCasing, (raw) => {
      const resolved = Effect.runSync(resolveLocale(config, raw))
      expect(config.supported).toContain(resolved)
    }))
  })

  it('an unsupported, non-blank locale always fails with a ValidationFailed naming the locale', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }).filter((s) => {
      const n = s.trim().toLowerCase()
      return n !== '' && !config.supported.includes(n)
    }), (value) => {
      const exit = Effect.runSyncExit(resolveLocale(config, value))
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error.issues).toEqual([{ path: ['locale'], message: `Unsupported locale: ${value.trim().toLowerCase()}` }])
      }
    }))
  })

  it('array input takes only the first element', () => {
    fc.assert(fc.property(arbSupported, fc.string(), (first, rest) => {
      expect(Effect.runSync(resolveLocale(config, [first, rest]))).toBe(first)
    }))
  })
})

describe('resolveUnitLocale', () => {
  it('a non-translatable collection is always a no-op', () => {
    fc.assert(fc.property(fc.constantFrom<'create' | 'update'>('create', 'update'), fc.string(), (kind, locale) => {
      const out = Effect.runSync(resolveUnitLocale(config, {
        kind, translatable: false, multiTranslation: false, isSingletonWrite: false,
        hasLocaleKey: true, locale, hasTranslationGroupKey: false, translationGroupCandidate: 'x',
      }))
      expect(out).toEqual({})
    }))
  })

  it('create on a multi-translation collection always assigns a translation group when absent', () => {
    fc.assert(fc.property(arbSupported, (locale) => {
      const out = Effect.runSync(resolveUnitLocale(config, {
        kind: 'create', translatable: true, multiTranslation: true, isSingletonWrite: false,
        hasLocaleKey: true, locale, hasTranslationGroupKey: false, translationGroupCandidate: 'gen-id',
      }))
      expect(out.translationGroup).toBe('gen-id')
    }))
  })

  it('create never assigns a translation group when one is already present', () => {
    fc.assert(fc.property(arbSupported, (locale) => {
      const out = Effect.runSync(resolveUnitLocale(config, {
        kind: 'create', translatable: true, multiTranslation: true, isSingletonWrite: false,
        hasLocaleKey: true, locale, hasTranslationGroupKey: true, translationGroupCandidate: 'gen-id',
      }))
      expect(out.translationGroup).toBeUndefined()
    }))
  })

  it('a singleton write always takes the given singleton locale verbatim, even an unsupported string', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), (singletonLocale) => {
      const out = Effect.runSync(resolveUnitLocale(config, {
        kind: 'update', translatable: true, multiTranslation: false, isSingletonWrite: true,
        singletonLocale, hasLocaleKey: false, hasTranslationGroupKey: false, translationGroupCandidate: 'x',
      }))
      expect(out.locale).toBe(singletonLocale)
    }))
  })

  it('an update that never touches locale is a genuine no-op (no `locale` key at all)', () => {
    const out = Effect.runSync(resolveUnitLocale(config, {
      kind: 'update', translatable: true, multiTranslation: false, isSingletonWrite: false,
      hasLocaleKey: false, hasTranslationGroupKey: false, translationGroupCandidate: 'x',
    }))
    expect('locale' in out).toBe(false)
  })

  it('an update that DOES touch locale (non-singleton) always re-normalizes it', () => {
    fc.assert(fc.property(arbSupported, (locale) => {
      const out = Effect.runSync(resolveUnitLocale(config, {
        kind: 'update', translatable: true, multiTranslation: false, isSingletonWrite: false,
        hasLocaleKey: true, locale, hasTranslationGroupKey: false, translationGroupCandidate: 'x',
      }))
      expect(out.locale).toBe(locale)
    }))
  })
})
