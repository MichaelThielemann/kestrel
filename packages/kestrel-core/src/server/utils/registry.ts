import { createError } from 'h3'
import { globalPipelineNames, invalidatePipelineCache, nameCollision, setCollectionProbe } from '../pipeline/registry.js'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'

const registry = new Map<string, BuiltCollection>()

// Bumped on every mutation — an O(1) cache-invalidation signal for a consumer (e.g. the content
// ownership adapter, `content-db.ts`) that would otherwise have to re-derive a fingerprint from
// `allCollections()` on every call, which registration itself never needs to pay for.
let version = 0

setCollectionProbe((name) => registry.has(name))

/** @public */
export function registerCollection(collection: BuiltCollection): void {
  // `/api/<name>` addresses a collection-less pipeline and `/api/<name>/<op>` a collection, so one name can
  // never be both. Checked in both registration orders (see `setCollectionProbe`) — at boot, never at runtime.
  if (globalPipelineNames().includes(collection.name)) throw nameCollision(collection.name, 'collection')
  invalidatePipelineCache() // a built-in read pipeline's access declaration is derived from the collection
  // A consumer collection sharing a name with a built-in (or another) silently overwrites it in the Map.
  // Warn so an accidental clash is visible, while still allowing a deliberate override (last one wins).
  if (registry.has(collection.name)) {
    console.warn(`[kestrel] collection "${collection.name}" is registered more than once — the later definition wins`)
  }
  registry.set(collection.name, collection)
  version++
}

/** Current registry generation — increments on every `registerCollection`/`clearRegistry` call.
 * @public
 */
export function registryVersion(): number {
  return version
}

/** @public */
export function getCollection(name: string): BuiltCollection | undefined {
  return registry.get(name)
}

/** For code addressing a collection it ships itself (an extension pipeline over its own collection):
 * @public
 *  absence is a server misconfiguration, not a client mistake — hence 500, unlike `getCollectionOr404`. */
export function requireRegisteredCollection(name: string): BuiltCollection {
  const collection = registry.get(name)
  if (!collection) throw createError({ statusCode: 500, statusMessage: `${name} collection is not registered` })
  return collection
}

/** @public */
export function allCollections(): BuiltCollection[] {
  return [...registry.values()]
}

/** @public */
export function clearRegistry(): void {
  registry.clear()
  invalidatePipelineCache()
  version++
}
