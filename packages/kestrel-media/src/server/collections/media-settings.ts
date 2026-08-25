import { buildCollection, defineCollection  } from '@kestrel/core'

// The usage-driven variant REGISTRY: a single-row store of the active image-variant set (name × size ×
// format presets) that the upload path derives and the generate-time scan reconciles. A singleton so it
// reuses the schema engine + (later) the singleton editor, but `nav: false` — it is a system/config store,
// not content, and must not appear as a flat top-level rail item beside the media library. It is surfaced
// (if at all) through a Media sub-menu once the rail supports nested navigation.
/** The `media_settings` built collection.
 * @public
 */
const built = buildCollection(defineCollection({
  name: 'media_settings',
  mode: 'single',
  translatable: false,
  builtin: true,
  nav: false,
  label: { singular: 'Media settings', plural: 'Media settings' },
  icon: 'sliders',
  fields: {
    // The resolved variant set (`StoredVariant[]`): each entry carries its provenance (`source`/`pinned`)
    // so the scan reconcile can replace discovered entries while preserving hand-authored ones.
    variants: { type: 'json' },
  },
}))

/** The `media_settings` Drizzle table.
 * @public
 */
export const mediaSettings = built.table
export default built
