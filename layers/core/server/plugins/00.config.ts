import { setResolvedKestrelConfig } from '@kestrel/core'
import { resolveServerKestrelConfig } from '../utils/server-config'

// Runs before every other core plugin (00.migrate.ts included — it calls useDb(), which now reads the
// provider) and before media/auth/collections/public's own plugins (docs/internals/architecture.md § Server
// plugins: core → media → auth → collections → public). Resolves the config ONCE with the app's own
// runtimeConfig-preferred, file/env-fallback precedence and pushes it into the config provider — the seam
// package code (locale.ts, revision-retention.ts, db.ts today; the future package-side movers of the
// same files) reads from instead of touching `useRuntimeConfig()` directly.
export default defineNitroPlugin(() => {
  setResolvedKestrelConfig(resolveServerKestrelConfig())
})
