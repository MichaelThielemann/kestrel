import { migrateRevisions, useDb, type MigrateRevisionsResult } from '@kestrel/core'

// Thin Nitro wrapper (defineTask is a runtime global) around the core, independently-unit-tested
// `migrateRevisions` (db/revision-migration.ts) — same sync/task split as db:migrate (schema/sync.ts +
// tasks/db/migrate.ts). Dev: GET/POST http://localhost:3000/_nitro/tasks/db:migrate-revisions ; prod: call
// runTask('db:migrate-revisions', { payload }) from inside the process — the built node-server has no task
// CLI/endpoint. Payload: {force:true} required, or the run refuses.
export default defineTask<MigrateRevisionsResult[]>({
  meta: {
    name: 'db:migrate-revisions',
    description: 'Seed revision 1 for every existing row with no revision history yet. Requires {"force":true}.',
  },
  run({ payload }) {
    const p = (payload ?? {}) as { force?: boolean }
    const result = migrateRevisions(useDb(), { force: p.force === true })
    const totalSeeded = result.reduce((n, r) => n + r.seeded, 0)
    console.info(`[kestrel] db:migrate-revisions seeded ${totalSeeded} revision(s) across ${result.length} collection(s)`)
    return { result }
  },
})
