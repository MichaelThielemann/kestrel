import { findMediaUsages } from '../../../utils/usages'
import { requireMediaCollection } from '../../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  const id = requireId(event)
  return { id, usages: findMediaUsages(useDb(), id) }
})
