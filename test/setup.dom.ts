import { config } from '@vue/test-utils'
import UiIcon from '../layers/ui/app/components/ui/Icon.vue'
import { en } from '../layers/ui/app/i18n/en'
import { translate } from '../layers/ui/app/composables/useT'
import { useDragReorder } from '../layers/ui/app/composables/useDragReorder'

// The `dom` project mounts components without Nuxt's auto-imports. Provide the admin-i18n helpers,
// backed by the real English catalog, so any component that calls `useT()` renders real strings
// (keeping literal assertions valid) instead of throwing on an undefined global. The real
// `useDragReorder` composable is provided too (it is pure, so the actual implementation is used).
Object.assign(globalThis, {
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) => translate(en, en, key, params),
    lang: { value: 'en' },
  }),
  useAdminLang: () => ({ value: 'en' }),
  useDragReorder,
})

// Same gap for auto-imported components: a component whose template renders <KestrelUiIcon> resolves it to
// nothing here, so the icon is missing from the rendered output and Vue logs a resolve warning on every
// mount. Register the real primitive under its Nuxt-derived name — add a line here for any further
// `KestrelUi*` primitive that ends up nested inside a dom-tested component.
Object.assign(config.global.components, { KestrelUiIcon: UiIcon })
