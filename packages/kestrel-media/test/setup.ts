import { resolveKestrel, setResolvedKestrelConfig } from '@kestrel/core'
// Side-effect import: seeds the real built-in field-type descriptors (text/json/media/...) media's own
// collections (`media`, `media_settings`) build against — @kestrel/fields is a real dependency direction
// here (media -> fields is fine; only core -> fields is the forbidden one), so this uses the genuine
// descriptors rather than a synthetic test-only subset.
import '@kestrel/fields'

setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
