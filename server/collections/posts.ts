import { buildCollection } from '../../layers/fields/server/utils/buildCollection'
import { defineCollection } from '../../layers/core/server/utils/defineCollection'

const built = buildCollection(defineCollection({
  name: 'posts',
  mode: 'multi',
  translatable: true,
  pageLike: true,
  status: true,
  label: { singular: { en: 'Post', de: 'Beitrag' }, plural: { en: 'Posts', de: 'Beiträge' }, new: { en: 'New Post', de: 'Neuer Beitrag' } },
  icon: 'newspaper',
  fields: { title: { type: 'text', required: true }, body: { type: 'richtext' } },
}))

export const posts = built.table
export default built
