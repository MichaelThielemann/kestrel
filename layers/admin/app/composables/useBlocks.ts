import type { SerializedBlock } from '../../../core/server/utils/serialize-collection'

// Thin wrapper over the shared cached-resource loader; keeps the named `blocks` return.
export function useBlocks() {
  const { state: blocks, load } = useCachedResource<SerializedBlock>('kestrel-blocks', '/api/blocks')
  return { blocks, load }
}
