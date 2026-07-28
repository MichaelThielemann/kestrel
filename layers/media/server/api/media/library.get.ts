import { listLibrary } from '../../utils/library'
import { useStorageDriver } from '../../../../core/server/utils/storage'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  const query = getQuery(event)
  const driver = useStorageDriver()
  return listLibrary(useDb(), {
    folder: typeof query.folder === 'string' ? query.folder : '',
    search: typeof query.search === 'string' ? query.search : undefined,
    type: query.type === 'image' ? 'image' : 'all',
    page: query.page ? Number(query.page) : undefined,
    perPage: query.perPage ? Number(query.perPage) : undefined,
    sort: typeof query.sort === 'string' ? query.sort : undefined,
  }, (key) => driver.publicUrl(key))
})
