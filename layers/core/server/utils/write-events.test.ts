import { describe, it, expect, beforeEach } from 'vitest'
import { registerWriteListener, emitWrite, clearWriteListeners } from './write-events'
import type { CollectionDef } from './defineCollection'

const def = { name: 'pages', mode: 'multi', fields: {} } as CollectionDef

beforeEach(clearWriteListeners)

describe('write-events', () => {
  it('dispatches a write to every registered listener', () => {
    const seen: unknown[] = []
    registerWriteListener((e) => seen.push(e))
    emitWrite(def, null, { id: 1 })
    expect(seen).toEqual([{ def, before: null, after: { id: 1 } }])
  })

  it('a throwing listener never breaks emitWrite (a publish error must not fail the CRUD write)', () => {
    registerWriteListener(() => { throw new Error('boom') })
    const ok: unknown[] = []
    registerWriteListener((e) => ok.push(e))
    expect(() => emitWrite(def, { id: 2 }, null)).not.toThrow()
    expect(ok).toHaveLength(1)
  })

  it('no listeners → no-op', () => {
    expect(() => emitWrite(def, null, null)).not.toThrow()
  })
})
