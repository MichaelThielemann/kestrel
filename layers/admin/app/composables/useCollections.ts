import type { SerializedCollection } from '@michaelthielemann/kestrel-core'

export function useCollections() {
  const { state: collections, load } = useCachedResource<SerializedCollection>('kestrel-collections', '/api/collections')
  return { collections, load }
}
