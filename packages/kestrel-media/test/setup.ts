import { resolveKestrel, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
// Side-effect import: seeds the real built-in field-type descriptors (text/json/media/...) media's own
// collections (`media`, `media_settings`) build against — @michaelthielemann/kestrel-fields is a real dependency direction
// here (media -> fields is fine; only core -> fields is the forbidden one), so this uses the genuine
// descriptors rather than a synthetic test-only subset.
import '@michaelthielemann/kestrel-fields'

setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
