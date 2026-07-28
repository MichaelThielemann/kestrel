import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'

const built = buildCollection(defineCollection({
  name: 'media',
  mode: 'multi',
  translatable: false,
  builtin: true,
  label: { singular: 'Media', plural: 'Media' },
  icon: 'image',
  fields: {
    storageKey: { type: 'text', required: true, unique: true },
    // Indexed: the library lists/filters/rolls-up recursive sizes by folder on every request.
    folder: { type: 'text', index: true },
    filename: { type: 'text', required: true },
    mime: { type: 'text', required: true },
    ext: { type: 'text', required: true },
    size: { type: 'number', required: true },
    width: { type: 'number' },
    height: { type: 'number' },
    checksum: { type: 'text' },
    thumbhash: { type: 'text' },
    derivatives: { type: 'json' },
    translations: { type: 'json' },
  },
}))

export const media = built.table
export default built
