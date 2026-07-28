import { describe, it, expect, beforeAll } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { buildTable } from '../../../../layers/fields/server/utils/buildTable'
import { defineCollection } from '../../../../layers/core/server/utils/defineCollection'
import type { CollectionDef } from '../../../../layers/core/server/utils/defineCollection'

// `defineCollection` is auto-imported at runtime; stub it before importing the module directly, the same
// shape a Nitro/Vue auto-import would provide.
let galleryProofing: CollectionDef

beforeAll(async () => {
  (globalThis as Record<string, unknown>).defineCollection = defineCollection
  galleryProofing = (await import('./gallery-proofing')).default
})

describe('galleryProofing table — gallerySlug is indexed', () => {
  it('emits an index on gallery_slug so the anonymous (slug, customerId) lookup and per-slug count(*) are not full scans', () => {
    const t = buildTable(galleryProofing)
    const names = getTableConfig(t).indexes.map((i) => i.config.name)
    expect(names).toContain('galleryProofing_gallery_slug')
  })
})
