import media from '../../collections/media'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  const query = getQuery(event)
  return list(useDb(), media, {
    locale: query.locale as string | undefined,
    sort: query.sort as string | undefined,
    page: query.page ? Number(query.page) : undefined,
    perPage: query.perPage ? Number(query.perPage) : undefined,
    filter: parseFilter(query as Record<string, unknown>),
    depth: query.depth ? Number(query.depth) : 0,
  })
})
