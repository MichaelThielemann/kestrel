import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runDevSchemaSync } from '../../../src/server/schema/dev-sync.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { buildTable, defineCollection } from '../../../src/index.js'
const old = buildTable(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: { keep: { type: 'text' } } }))
const withRequired = buildTable(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: { keep: { type: 'text' }, req: { type: 'text', required: true } } }))

describe('runDevSchemaSync — error isolation', () => {
  it('does NOT throw when syncSchema fails — logs an error and leaves the server running', () => {
    const db = new Database(':memory:') as unknown as Parameters<typeof runDevSchemaSync>[0]
    runDevSchemaSync(db, desiredSchema([old]))
    ;(db as unknown as Database.Database).prepare("INSERT INTO x (keep, created_at, updated_at) VALUES ('v', 0, 0)").run()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // adding a required (NOT NULL, no default) column to the now-populated table is infeasible →
    // syncSchema throws; the wrapper must swallow it, not propagate (which would 500 every route).
    expect(() => runDevSchemaSync(db, desiredSchema([withRequired]))).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('applies a feasible additive sync normally (no error log)', () => {
    const db = new Database(':memory:') as unknown as Parameters<typeof runDevSchemaSync>[0]
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => runDevSchemaSync(db, desiredSchema([old]))).not.toThrow()
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
