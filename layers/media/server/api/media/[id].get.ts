import media from '../../collections/media'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  const query = getQuery(event)
  const depth = Number(query.depth ?? 0)
  const locale = query.locale as string | undefined
  return getOne(useDb(), media, requireId(event), depth, locale)
})
