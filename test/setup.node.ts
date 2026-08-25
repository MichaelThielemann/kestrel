// In the real app, `kestrel-fields`'s built-in field-type descriptors are always registered into
// `core`'s field-type registry before any collection is built (any Nuxt boot loads both layers together).
// A node test that imports `core`'s schema engine (`buildTable`/`buildCollection`) directly, without going
// through `fields`, has no such guarantee — importing this module's side effect seeds the registry the
// same way the real app does. Imported as a USED BINDING, not a bare side-effect import: a pure
// side-effect import is exactly what once let a bundler prove the module's other top-level statements
// (the seeding call) were unneeded and tree-shake them away in production — referencing the binding here
// is the same defense.
import { fieldTypes } from '@kestrel/fields'

// In the real app, `00.config.ts` (the earliest core plugin) resolves the config ONCE at boot and pushes
// it into the config provider before anything reads it. A node test that calls `locale.ts`/`db.ts`/
// `revision-retention.ts` (or their future package-side homes) directly, with no Nuxt boot, has no such
// guarantee — seed it here the same way, with the SAME fallback (env + the committed `kestrel.config.ts`)
// those readers already got when this ran lazily per-call.
import { setResolvedKestrelConfig } from '@kestrel/core'
import { resolveServerKestrelConfig } from '../layers/core/server/utils/server-config'

void fieldTypes
setResolvedKestrelConfig(resolveServerKestrelConfig())
