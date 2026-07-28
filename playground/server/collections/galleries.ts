// CONSUMER-defined collection (Pruvious-style): a plain MULTI collection you maintain as a record FORM —
// title, a customer-facing `slug`, the `secureGallery` field (the editor widget handles password + encrypted
// upload), and the Public/Not-public toggle (`status`). NOT pageLike + no block-builder — the photographer
// just fills a form per gallery. The customer reaches a published gallery via the consumer's own public
// route `app/pages/g/[slug].vue` (which fetches the manifest from `server/api/public-gallery`, opened to
// anonymous read for ONE published gallery via the core access grant seam — see the plugin). `defineCollection`
// is auto-imported.
export default defineCollection({
  name: 'galleries',
  mode: 'multi',
  status: true,
  fields: {
    title: { type: 'text', required: true },
    // Auto-generated from `title` on save (editable); the widget shows the `/galleries/` prefix. Not
    // `required` so it can be left blank and derived; `unique` keeps each customer URL distinct.
    slug: { type: 'slug', unique: true, options: { from: 'title', prefix: '/galleries/' } },
    gallery: { type: 'secureGallery' },
  },
  label: { singular: 'Gallery', plural: 'Galleries', new: 'New gallery' },
  icon: 'image',
})
