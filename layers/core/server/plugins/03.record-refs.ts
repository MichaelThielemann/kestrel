import { registerWriteListener } from '../utils/write-events'
import { maintainRecordRefs } from '../utils/record-ref-index'

/**
 * Keep the durable `record_refs` index current on every content write — in ALL environments (the dead-
 * reference warnings it powers are an editor feature, not gated on publishing, so unlike the publish
 * plugin this is never skipped in dev). Its own listener, so it coexists with the publish listener; the
 * bus try/catch-isolates each, so an index-maintenance failure never breaks the content write.
 */
export default defineNitroPlugin(() => {
  registerWriteListener((event) => maintainRecordRefs(useDb(), event))
})
