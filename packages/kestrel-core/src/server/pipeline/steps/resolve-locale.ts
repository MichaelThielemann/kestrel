import { Effect } from 'effect'
import { nanoid } from 'nanoid'
import { primaryLocale, supportedLocales } from '../../utils/locale.js'
import { resolveUnitLocale, type LocaleConfig } from '../core/locale.js'
import { collectionOf, isSingletonWrite, unitsOf } from './shared.js'
import { syncStep, type StepDef } from '../types.js'

/** @public */
export function resolveLocaleStep(kind: 'create' | 'update'): StepDef {
  return syncStep('resolveLocale', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    if (!c.def.translatable) return
    const config: LocaleConfig = { supported: supportedLocales(), primary: primaryLocale() }
    for (const unit of unitsOf(ctx)) {
      const out = yield* resolveUnitLocale(config, {
        kind,
        translatable: true,
        multiTranslation: c.def.mode === 'multi',
        isSingletonWrite: isSingletonWrite(ctx),
        singletonLocale: ctx.work.singletonLocale as string | undefined,
        hasLocaleKey: 'locale' in unit.values,
        locale: unit.values.locale as string | string[] | undefined,
        hasTranslationGroupKey: !!unit.values.translationGroup,
        translationGroupCandidate: nanoid(),
      })
      if (out.locale !== undefined) unit.values.locale = out.locale
      if (out.translationGroup !== undefined) unit.values.translationGroup = out.translationGroup
    }
  }))
}
