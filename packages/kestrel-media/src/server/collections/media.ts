import { buildCollection, defineCollection  } from '@michaelthielemann/kestrel-core'

/** The `media` built collection.
 * @public
 */
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
    // EU AI Act Art. 50 disclosure. Top-level, NOT per-locale (`translations`): how an asset was produced
    // does not change per translation. The vocabulary mirrors the disclosure-relevant subset of IPTC's
    // Digital Source Type, so a later metadata-embedding slice can map 1:1.
    aiSourceType: {
      type: 'choice',
      options: {
        choices: [
          { label: 'Fully AI-generated', value: 'trainedAlgorithmicMedia' },
          { label: 'AI content composited into real media', value: 'compositeWithTrainedAlgorithmicMedia' },
          { label: 'AI-enhanced / algorithmically edited', value: 'algorithmicallyEnhanced' },
        ],
      },
    },
    aiNote: { type: 'text' },
  },
}))

/** The `media` Drizzle table.
 * @public
 */
export const media = built.table
export default built
