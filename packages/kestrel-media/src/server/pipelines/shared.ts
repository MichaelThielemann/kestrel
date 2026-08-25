import type { AccessSpec } from '@kestrel/core'

/** `resource` stays unset: it defaults to the collection name (`media`), which is what the role policy and
 *  the registered grants are keyed on. */
export const MEDIA_READ_ACCESS: AccessSpec = { role: 'admin', scope: 'all' }
export /**
 *
 */
const MEDIA_WRITE_ACCESS: AccessSpec = { role: 'admin' }
