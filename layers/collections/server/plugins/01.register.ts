import collections from '#kestrel/collections'
import blocks from '#kestrel/blocks'
import { registerBlock, type BlockDef } from '@kestrel/fields'
import { ensureBuilt, collectionEnabled, registerCollection  } from '@kestrel/core'
import { resolveServerKestrel, serverRuntimeConfig } from '../../../core/server/utils/server-config'
import type { BuiltCollection, CollectionDef } from '@kestrel/core'
// Auto-discovered collection files default-export either a plain CollectionDef (the common consumer
// form, `export default defineCollection(…)`) or an already-built collection (advanced). `ensureBuilt`
// normalizes both so the registry only ever holds BuiltCollections.
//
// NOTE on ordering: this plugin's real execution position is declared data now
// (layers/core/modules/plugin-order/plugin-order.ts), not an accident of filename/layer scan order — it
// runs after every core plugin (00.migrate/02.schema-sync included), identically in both build contexts.
// It is order-free regardless: nothing reads the registry at plugin init — migrate/schema-sync read the
// `#kestrel/collections` virtual directly, and the ref/cleanup/publish plugins register deferred listeners.
// Keep that invariant — do not add an init-time allCollections() read.
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
