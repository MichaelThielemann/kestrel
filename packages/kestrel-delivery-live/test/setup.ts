import { resolveKestrel, setResolvedKestrelConfig } from '@kestrel/core'

setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
