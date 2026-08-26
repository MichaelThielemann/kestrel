// A consumer-defined collection. On dev start Kestrel discovers it, builds its table and migrates it
// into the DB automatically. (`translatable` defaults to false when omitted.)
import { defineCollection } from '@michaelthielemann/kestrel-core'

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
