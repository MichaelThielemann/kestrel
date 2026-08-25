import { resolveKestrel, setResolvedKestrelConfig } from '@kestrel/core'
// Side-effect import: seeds the real built-in field-type descriptors (text/json/media/...) this package's
// tests build real collections/populators against — collections -> fields is a real dependency direction
// here (only core -> fields is forbidden), so this uses the genuine descriptors rather than a synthetic
// test-only subset.
import '@kestrel/fields'

setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
