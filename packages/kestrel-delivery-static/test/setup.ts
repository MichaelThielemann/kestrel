import { resolveKestrel, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'

setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
