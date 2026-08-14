import { describe, it, expect, beforeEach } from 'vitest'
import type { CollectionDef } from './defineCollection'
import { registerWriteEffect, clearWriteEffects, runWriteEffects } from './write-effects'

const def = { name: 'redirects', mode: 'single', fields: {} } as CollectionDef
const other = { name: 'posts', mode: 'multi', fields: {} } as CollectionDef

describe('write effects', () => {
  beforeEach(() => clearWriteEffects())

  it('runs every registered effect with the written row', async () => {
    const seen: unknown[] = []
    registerWriteEffect((e) => { seen.push(['a', e.def.name, e.row.id]) })
    registerWriteEffect((e) => { seen.push(['b', e.def.name, e.row.id]) })
    await runWriteEffects(def, { id: 7 })
    expect(seen).toEqual([['a', 'redirects', 7], ['b', 'redirects', 7]])
  })

  it('awaits an async effect before resolving', async () => {
    let done = false
    registerWriteEffect(async () => { await Promise.resolve(); done = true })
    await runWriteEffects(def, { id: 1 })
    expect(done).toBe(true)
  })

  it('propagates a rejection — unlike the write bus, an effect CAN fail the save', async () => {
    registerWriteEffect(() => { throw new Error('artifact write failed') })
    await expect(runWriteEffects(def, { id: 1 })).rejects.toThrow('artifact write failed')
  })

  it('propagates an async rejection too', async () => {
    registerWriteEffect(() => Promise.reject(new Error('s3 down')))
    await expect(runWriteEffects(def, { id: 1 })).rejects.toThrow('s3 down')
  })

  it('stops at the first failing effect rather than running the rest', async () => {
    const after: string[] = []
    registerWriteEffect(() => { throw new Error('boom') })
    registerWriteEffect(() => { after.push('ran') })
    await expect(runWriteEffects(def, { id: 1 })).rejects.toThrow('boom')
    expect(after).toEqual([])
  })

  it('is a no-op with nothing registered', async () => {
    await expect(runWriteEffects(other, { id: 1 })).resolves.toBeUndefined()
  })

  it('clears every effect', async () => {
    registerWriteEffect(() => { throw new Error('boom') })
    clearWriteEffects()
    await expect(runWriteEffects(def, { id: 1 })).resolves.toBeUndefined()
  })
})
