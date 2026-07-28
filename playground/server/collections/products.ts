// A consumer-defined collection. `defineCollection` is auto-imported from the Kestrel meta-layer — no
// imports needed. Just default-export the definition; on dev start Kestrel discovers it, builds its
// table and migrates it into the DB automatically. (`translatable` defaults to false when omitted.)
export default defineCollection({
  name: 'products',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    price: { type: 'number', options: { integer: false } },
    inStock: { type: 'boolean' },
    image: { type: 'media' },
  },
})
