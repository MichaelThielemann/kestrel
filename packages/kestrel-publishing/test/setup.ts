import { resolveKestrel, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
// Seeds the real built-in field-type descriptors (text/json/media/...) — publisher.ts's dynamic
// `@michaelthielemann/kestrel-media` import (its `clearVariants`/`saveDiscoveredVariants` need) builds real
// `buildCollection()` schemas against the field-type registry (publishing -> media -> fields is a real
// dependency direction here, mirroring media's own `-> fields` import for the same reason). Imported as a
// USED BINDING, not a bare side-effect import (`import '@michaelthielemann/kestrel-fields'`) — this package declares
// `"sideEffects": false` in package.json, so a bare import is exactly what would let a bundler prove the
// registration call unneeded and tree-shake it away; referencing the binding defeats that (mirrors
// `test/setup.node.ts`'s own `fieldTypes` idiom, at the root of this repo).
import { fieldTypes } from '@michaelthielemann/kestrel-fields'

void fieldTypes
setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
