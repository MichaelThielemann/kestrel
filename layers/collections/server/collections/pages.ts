import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'

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

export const pages = built.table
export default built
