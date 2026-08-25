import { buildCollection, defineCollection  } from '@kestrel/core'

/**
 * `siteUrl`/`siteName` stay in `kestrel.config` on purpose: the build needs them for canonical URLs, the
 * sitemap and robots.txt, so they cannot live in the DB. What is here is editorial instead — and a write
 * re-publishes the routes that embed it, which a config value frozen at module setup can never do.
 * @public
 */
const built = buildCollection(defineCollection({
  name: 'site',
  mode: 'single',
  translatable: true,
  builtin: true,
  label: { singular: { en: 'Site', de: 'Website' }, plural: { en: 'Site', de: 'Website' } },
  icon: 'globe',
  fields: {
    baseTitle: { type: 'text', label: { en: 'Base title', de: 'Basis-Titel' } },
    titleSeparator: { type: 'text', label: { en: 'Title separator', de: 'Titel-Trenner' }, default: '|' },
    titlePosition: {
      type: 'choice',
      label: { en: 'Base title position', de: 'Position des Basis-Titels' },
      options: {
        choices: [
          { label: { en: 'After the page title', de: 'Nach dem Seitentitel' }, value: 'after' },
          { label: { en: 'Before the page title', de: 'Vor dem Seitentitel' }, value: 'before' },
        ],
        display: 'buttons',
      },
      default: 'after',
    },
    description: {
      type: 'text',
      label: { en: 'Default meta description', de: 'Standard-Meta-Beschreibung' },
      options: { multiline: true },
    },
    image: {
      type: 'media',
      label: { en: 'Default sharing image', de: 'Standard-Sharing-Bild' },
      options: { accept: 'image' },
    },
  },
  fieldLayout: [['baseTitle|2', 'titleSeparator|1'], 'titlePosition', 'description', 'image'],
}))

/** The `site` Drizzle table.
 * @public
 */
export const site = built.table
export default built
