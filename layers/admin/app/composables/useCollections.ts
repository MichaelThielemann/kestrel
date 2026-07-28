import type { SerializedCollection } from '../../../core/server/utils/serialize-collection'

// Thin wrapper over the shared cached-resource loader; keeps the named `collections` return.
export function useCollections() {
  const { state: collections, load } = useCachedResource<SerializedCollection>('kestrel-collections', '/api/collections')
  return { collections, load }
}
