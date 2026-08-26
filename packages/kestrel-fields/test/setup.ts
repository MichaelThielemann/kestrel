// This package's own real built-in field-type descriptors ARE the seed — unlike `@michaelthielemann/kestrel-core`'s test
// setup (which has to synthesize a same-shaped subset, since core cannot depend on fields), this suite
// just seeds core's registry with the real thing. A used binding, not a bare side-effect import — the
// same discipline the package's own `sideEffects` declaration and the production seed path rely on.
import { fieldTypes } from '../src/server/field-registry/index.js'

void fieldTypes
