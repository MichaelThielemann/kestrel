import { buildCollection } from '../../layers/fields/server/utils/buildCollection'
import { defineCollection } from '../../layers/core/server/utils/defineCollection'

const built = buildCollection(defineCollection({
  name: 'settings',
  mode: 'single',
  translatable: true,
  label: { singular: { en: 'Settings', de: 'Einstellungen' }, plural: { en: 'Settings', de: 'Einstellungen' } },
  icon: 'settings',
  fields: {
    // Website-wide SEO defaults (per locale).
    siteName: { type: 'text', translatable: true },
    metaTitle: { type: 'text', translatable: true },
    metaDescription: { type: 'text', translatable: true, options: { multiline: true } },
    // Main navigation menu: an ordered list of { label, link } items.
    mainMenu: {
      type: 'repeater',
      translatable: true,
      options: {
        fields: {
          label: { type: 'text', required: true },
          link: { type: 'link', options: { types: ['internal', 'external'] } },
        },
      },
    },
  },
}))

export const settings = built.table
export default built
