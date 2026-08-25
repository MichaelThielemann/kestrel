import { text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { isHardRequired, seedBuiltinFieldTypes, resolveKestrel, setResolvedKestrelConfig } from '@kestrel/core'
import type { FieldTypeDescriptor } from '@kestrel/core'

// `pipeline-claim.test.ts` builds a real collection (via buildCollection) to exercise route-claiming
// against genuine op paths — it only needs the 'text' type to do that. The real built-in descriptors live
// in `@kestrel/fields`, which this package does not depend on (wrong direction, same reasoning as
// kestrel-core's own test/setup.ts), so this seeds just the one type this package's tests actually use.
seedBuiltinFieldTypes({
  text: {
    column: (n, f) => (isHardRequired(f) ? text(n).notNull() : text(n)),
    validator: (f) => {
      const s = z.string().trim()
      return isHardRequired(f) ? s.min(1) : s.nullish()
    },
  } satisfies FieldTypeDescriptor,
})

setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
