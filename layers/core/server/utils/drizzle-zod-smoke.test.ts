import { describe, it, expect } from 'vitest'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { createInsertSchema } from 'drizzle-zod'
import { z } from 'zod'

const sample = sqliteTable('sample', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  payload: text('payload', { mode: 'json' }).$type<unknown[]>().notNull(),
})

const strict = z.array(z.object({ format: z.literal('ok') }))

describe('drizzle-zod override API (0.8.x)', () => {
  it('replaces a column schema when a Zod schema is passed in refinements', () => {
    const insert = createInsertSchema(sample, { payload: strict })
    expect(insert.safeParse({ payload: [{ format: 'ok' }] }).success).toBe(true)
    expect(insert.safeParse({ payload: [{ format: 'nope' }] }).success).toBe(false)
  })

  it('returns a Zod object exposing .partial() (used by singleton PUT in Task 12)', () => {
    expect(typeof createInsertSchema(sample).partial).toBe('function')
  })
})
