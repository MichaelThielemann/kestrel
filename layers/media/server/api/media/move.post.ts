import { runRelocation } from '../../utils/relocate-ops'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  return runRelocation(event, (items, body) => ({ type: 'move', items, dest: typeof body.dest === 'string' ? body.dest : '' }))
})
