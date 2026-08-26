import { fileURLToPath } from 'node:url'
import { defineConfig } from 'drizzle-kit'
import kestrelConfig from './kestrel.config'
import { resolveKestrel } from '@michaelthielemann/kestrel-core'

// Anchor relative DB paths on THIS file's directory — the package root the Nuxt app uses as `rootDir` —
// not on `process.cwd()`. In a pnpm workspace drizzle-kit is often invoked from the workspace root or a
// subdir, where `process.cwd()` !== the package root — anchoring there would make drizzle-kit migrate a
// different SQLite file than the one the app opens. resolveKestrel is the same single source the app
// uses, so `drizzle-kit` migrates exactly the DB that `kestrel: { db }` points at.
const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/database/schema.ts',
  out: './server/database/migrations',
  dbCredentials: { url: resolveKestrel(kestrelConfig, process.env, rootDir).dbPath },
})
