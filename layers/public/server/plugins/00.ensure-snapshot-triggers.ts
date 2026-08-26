import type Database from 'better-sqlite3'
import { useDb } from '@michaelthielemann/kestrel-core'
import { ensureSnapshotTriggers } from '@michaelthielemann/kestrel-publishing'

// Layer order puts every core-layer plugin (00.migrate, 02.schema-sync) before this layer's, so
// `published_snapshots` already exists here for either provisioning path (a committed migration inside
// Kestrel's own repo, or the schema engine for a consumer layer) — except a boot before EITHER has run,
// which `ensureSnapshotTriggers` itself tolerates (warns, does not crash). Skipped during prerender, same
// as `02.schema-sync`: no DDL runs in that phase.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  const client = (useDb() as unknown as { $client: Database.Database }).$client
  ensureSnapshotTriggers(client)
})
