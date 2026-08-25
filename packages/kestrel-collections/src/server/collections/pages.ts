import { buildCollection, defineCollection  } from '@kestrel/core'

/** The `pages` built-in collection.
 * @public
 */
const built = buildCollection(defineCollection({
  name: 'pages',
  mode: 'multi',
  translatable: true,
  pageLike: true,
  seo: true,
  blocks: { enabled: true },
  status: true,
  builtin: true,
  label: { singular: { en: 'Page', de: 'Seite' }, plural: { en: 'Pages', de: 'Seiten' }, new: { en: 'New Page', de: 'Neue Seite' } },
  icon: 'file-text',
  fields: { title: { type: 'text', required: true } },
}))

/** The `pages` Drizzle table.
 * @public
 */
export const pages = built.table
export default built
