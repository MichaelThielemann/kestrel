import { resolveKestrel, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'

// In the real app, `00.config.ts` (the earliest core plugin) resolves the config ONCE at boot and pushes
// it into the config provider before anything reads it. A node test that calls `session-epoch.ts`
// directly, with no Nuxt boot, has no such guarantee — seed it here the same way, with the SAME fallback
// (env + the committed `kestrel.config.ts`) those readers already get lazily per-call otherwise.
setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
