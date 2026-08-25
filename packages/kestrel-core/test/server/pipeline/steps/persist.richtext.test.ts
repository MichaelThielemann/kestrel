import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildCollection } from '../../../../src/server/schema/buildCollection.js'
import { defineCollection } from '../../../../src/index.js'
import { createTestDb } from '../../../../../../test/helpers/db.js'
import { desiredSchema } from '../../../../src/server/schema/desired.js'
import { diffSchema } from '../../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../../src/server/schema/render-sqlite.js'
import { revisionsTable } from '../../../../src/server/db/revisions.js'
import { createPipelineContext } from '../../../../src/server/pipeline/context.js'
import { runStepSync } from '../../../../../../test/helpers/run-effect.js'
import { asValidated } from '../../../../src/server/pipeline/steps/shared.js'
import { persistStep } from '../../../../src/server/pipeline/steps/persist.js'

const notes = buildCollection(defineCollection({
  name: 'notes',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    body: { type: 'richtext' },
  },
}))

let db: ReturnType<typeof createTestDb>
beforeEach(() => {
  db = createTestDb()
  for (const stmt of renderSqlite(diffSchema(desiredSchema([notes.table, revisionsTable('notes')]), {}))) db.run(sql.raw(stmt))
})

// persist is the last stop before the column write — this pins the defense-in-depth seam directly (a
// WriteUnit built without going through validate.ts's decodeInput, the way a future bypass could), not
// the ordinary validated-input path every other persist test already covers.
describe('persist — richtext columns are sanitized again at the write seam', () => {
  it('strips a <script> tag that reached persist without going through the field validator', () => {
    const ctx = createPipelineContext({
      op: 'createOne',
      collection: notes,
      db,
      work: { units: [{ values: asValidated({ title: 'x', body: '<script>alert(1)</script><p>hi</p>' }), before: null }] },
    })
    runStepSync(persistStep('createOne').fn(ctx))
    const row = ctx.output as Record<string, unknown>
    expect(row.body).not.toContain('<script')
    expect(row.body).toContain('<p>hi</p>')
  })

  it('leaves already-sanitized richtext untouched (idempotent, not just stripped)', () => {
    const ctx = createPipelineContext({
      op: 'createOne',
      collection: notes,
      db,
      work: { units: [{ values: asValidated({ title: 'x', body: '<p>hi</p>' }), before: null }] },
    })
    runStepSync(persistStep('createOne').fn(ctx))
    expect((ctx.output as Record<string, unknown>).body).toBe('<p>hi</p>')
  })

  it('leaves a non-richtext column alone', () => {
    const ctx = createPipelineContext({
      op: 'createOne',
      collection: notes,
      db,
      work: { units: [{ values: asValidated({ title: '<script>x</script>' }), before: null }] },
    })
    runStepSync(persistStep('createOne').fn(ctx))
    expect((ctx.output as Record<string, unknown>).title).toBe('<script>x</script>')
  })

  it('warns when the write-seam re-sanitize actually changes the value (the defense becomes observable)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = createPipelineContext({
      op: 'createOne',
      collection: notes,
      db,
      work: { units: [{ values: asValidated({ title: 'x', body: '<script>alert(1)</script>' }), before: null }] },
    })
    runStepSync(persistStep('createOne').fn(ctx))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('body'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notes'))
    warn.mockRestore()
  })

  it('stays silent when the value was already sanitized (no false alarm on the normal path)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = createPipelineContext({
      op: 'createOne',
      collection: notes,
      db,
      work: { units: [{ values: asValidated({ title: 'x', body: '<p>hi</p>' }), before: null }] },
    })
    runStepSync(persistStep('createOne').fn(ctx))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
