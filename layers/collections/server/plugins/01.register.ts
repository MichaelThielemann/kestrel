import collections from '#kestrel/collections'
import blocks from '#kestrel/blocks'
import { registerBlock, type BlockDef } from '../../../fields/server/utils/defineBlock'
import { ensureBuilt } from '../../../fields/server/utils/buildCollection'
import { resolveServerKestrel, serverRuntimeConfig } from '../../../core/server/utils/server-config'
import { collectionEnabled } from '../../../core/server/schema/bootstrap'
import type { CollectionDef } from '../../../core/server/utils/defineCollection'
import type { BuiltCollection } from '../../../core/server/utils/collection-types'

// Auto-discovered collection files default-export either a plain CollectionDef (the common consumer
// form, `export default defineCollection(…)`) or an already-built collection (advanced). `ensureBuilt`
// normalizes both so the registry only ever holds BuiltCollections.
//
// NOTE on ordering: the `01.` prefix sorts only WITHIN this (collections) layer. Nitro runs plugins by
// layer-then-filename, so this plugin does NOT run second — in-repo it runs LAST (after core's
// 00.migrate/02.schema-sync/03.record-refs), and the cross-layer order differs again for an
// `extends: ['@thielemann/kestrel']` consumer. That is safe ONLY because nothing reads the registry at plugin init:
// migrate/schema-sync read the `#kestrel/collections` virtual directly, and the ref/cleanup/publish
// plugins register deferred listeners. Keep that invariant — do not add an init-time allCollections() read.
export default defineNitroPlugin(() => {
  for (const block of blocks as BlockDef[]) registerBlock(block)
  // Built-in collections (`pages`, `media`) register by default but can be disabled per consumer via
  // `kestrel: { collections: { <name>: false } }`. Prefer the value the kestrel module put on runtimeConfig
  // (the consumer's `kestrel: {}`); fall back to Kestrel's own resolved config for non-Nitro / dev callers.
  const toggles = (serverRuntimeConfig()?.kestrel?.collections ?? resolveServerKestrel().collections) as Record<string, boolean>
  for (const collection of collections as (CollectionDef | BuiltCollection)[]) {
    const built = ensureBuilt(collection)
    // The shared predicate (schema/bootstrap) — the schema engine gates on exactly the same rule.
    if (!collectionEnabled(built.def, toggles)) continue
    registerCollection(built)
  }
})
