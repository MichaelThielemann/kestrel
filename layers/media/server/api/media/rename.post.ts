import { runRelocation } from '../../utils/relocate-ops'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  return runRelocation(event, (items, body) => ({ type: 'rename', items, name: typeof body.name === 'string' ? body.name : '' }))
})
