import type { BuiltCollection } from './collection-types'

const registry = new Map<string, BuiltCollection>()

export function registerCollection(collection: BuiltCollection): void {
  // A consumer collection sharing a name with a built-in (or another) silently overwrites it in the Map.
  // Warn so an accidental clash is visible, while still allowing a deliberate override (last one wins).
  if (registry.has(collection.name)) {
    console.warn(`[kestrel] collection "${collection.name}" is registered more than once — the later definition wins`)
  }
  registry.set(collection.name, collection)
}

export function getCollection(name: string): BuiltCollection | undefined {
  return registry.get(name)
}

export function allCollections(): BuiltCollection[] {
  return [...registry.values()]
}

export function clearRegistry(): void {
  registry.clear()
}
