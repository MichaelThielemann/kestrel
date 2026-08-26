import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ResolvedMedia } from '@michaelthielemann/kestrel-media'
import type { ResolvedVariant } from '@michaelthielemann/kestrel-core'
import { buildPictureModel, requestVariantSpecs, type VariantRequest, type PictureModel } from '../utils/picture-model'

/**
 * Reactive `<picture>` view-model for a resolved media + a variant request. The single render-AND-declare
 * site: one call may declare MULTIPLE sizes + formats. During a publish/generate SSR render it also stashes
 * the call's concrete specs on the request event, so the publish `beforeResponse` hook collects them and the
 * end-of-publish reconcile registers exactly what was rendered (usage-driven auto-discovery). Server-guarded,
 * so it is a no-op on the client and in non-Nuxt unit mounts.
 */
export function useMediaVariant(
  media: MaybeRefOrGetter<ResolvedMedia | null | undefined>,
  request: MaybeRefOrGetter<VariantRequest>,
  opts?: { priority?: MaybeRefOrGetter<boolean> },
) {
  if (import.meta.server) {
    const specs = requestVariantSpecs(toValue(request))
    if (specs.length) {
      const ev = useRequestEvent()
      if (ev) {
        const ctx = ev.context as { kestrelVariants?: ResolvedVariant[] }
        ;(ctx.kestrelVariants ??= []).push(...specs)
      }
    }
  }
  const model = computed<PictureModel | null>(() => {
    const m = toValue(media)
    if (!m) return null
    return buildPictureModel(m, toValue(request), { lazy: !toValue(opts?.priority ?? false) })
  })
  return { model }
}
