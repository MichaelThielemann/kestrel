import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { useDb } from '@kestrel/core'

export default defineNitroPlugin(() => {
  // The committed drizzle-kit migrations only exist in Kestrel's own repo. When Kestrel is consumed as
  // a layer, this folder is absent — there the schema-sync engine (02.schema-sync in dev, the db:migrate
  // task in prod) owns the schema instead (ADR-0002), so skip rather than throw.
  const migrationsFolder = resolve(process.cwd(), 'server/database/migrations')
  if (existsSync(migrationsFolder)) migrate(useDb(), { migrationsFolder })
})
