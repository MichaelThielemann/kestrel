// Registers the built-in field types (module-load side effect in `@michaelthielemann/kestrel-fields` itself). Must run
// before this barrel's own `buildCollection()` call (pages.js) evaluates — an ESM barrel is an eager,
// whole-module-graph load (ADR-0029), so ANY consumer importing anything at all from this package —
// including a direct import that bypasses `kestrel-nuxt`'s own `#kestrel/collections` virtual guard
// entirely — would otherwise reach `pages`'s definition before the registry has "text" et al. Placed first
// so file order (not what the consumer actually imports) is what guarantees the ordering.
//
// Imported as a USED BINDING, not a bare side-effect import — this package declares `"sideEffects": false`
// in package.json, so a bare import is exactly what would let a compliant bundler tree-shake it away.
// Mirrors `@michaelthielemann/kestrel-publishing`'s and `@michaelthielemann/kestrel-media`'s own barrels.
import { fieldTypes } from '@michaelthielemann/kestrel-fields'
import type { KestrelPackageDiscovery } from '@michaelthielemann/kestrel-core'
import pagesCollectionDefault from './server/collections/pages.js'

void fieldTypes

export { pages, default as pagesCollection } from './server/collections/pages.js'
export {
  type ResolveRecord,
  skipMissing,
  buildRelationFieldPopulator,
} from './server/utils/populate-relations.js'

/** `kestrel-nuxt`'s auto-discovery reads this — see `@michaelthielemann/kestrel-core`'s `KestrelPackageDiscovery` TSDoc.
 * First-party discovery contract — consumers extend Kestrel via layer directories, see
 * `docs/guide/collections.md`.
 * @alpha
 */
export const kestrelDiscovery: KestrelPackageDiscovery = {
  collections: [pagesCollectionDefault],
}
