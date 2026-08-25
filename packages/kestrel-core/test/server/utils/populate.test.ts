import { describe, it, expect, afterEach } from 'vitest'
import {
  registerPopulator,
  clearPopulator,
  populateRow,
  registerFieldPopulator,
  getFieldPopulator,
  clearFieldPopulators,
} from '../../../src/server/utils/populate.js'
import { defineCollection } from '../../../src/server/utils/defineCollection.js'

const def = defineCollection({ name: 't', mode: 'multi', translatable: false, fields: {} })
afterEach(() => {
  clearPopulator()
  clearFieldPopulators()
})

describe('populator registry', () => {
  it('is a pass-through when no populator is registered', () => {
    expect(populateRow({ id: 1 }, { depth: 2, locale: 'en', def })).toEqual({ id: 1 })
  })
  it('is a pass-through at depth 0 even with a populator', () => {
    registerPopulator((row) => ({ ...row, touched: true }))
    expect(populateRow({ id: 1 }, { depth: 0, locale: 'en', def })).toEqual({ id: 1 })
  })
  it('applies the registered populator at depth > 0', () => {
    registerPopulator((row, ctx) => ({ ...row, depth: ctx.depth, locale: ctx.locale }))
    expect(populateRow({ id: 1 }, { depth: 1, locale: 'de', def })).toEqual({ id: 1, depth: 1, locale: 'de' })
  })
  it('composes every registered populator in registration order', () => {
    registerPopulator((row) => ({ ...row, order: [...((row.order as number[]) ?? []), 1] }))
    registerPopulator((row) => ({ ...row, order: [...((row.order as number[]) ?? []), 2] }))
    expect(populateRow({ id: 1 }, { depth: 1, locale: 'en', def })).toEqual({ id: 1, order: [1, 2] })
  })
  it('clearPopulator removes all registered populators', () => {
    registerPopulator((row) => ({ ...row, a: true }))
    registerPopulator((row) => ({ ...row, b: true }))
    clearPopulator()
    expect(populateRow({ id: 1 }, { depth: 1, locale: 'en', def })).toEqual({ id: 1 })
  })
})

describe('per-field-type populator registry (the Pruvious-style seam the field-tree walker dispatches into)', () => {
  it('registers and looks up a populator by field-type name', () => {
    const fn = () => {}
    expect(getFieldPopulator('media')).toBeUndefined()
    registerFieldPopulator('media', fn)
    expect(getFieldPopulator('media')).toBe(fn)
  })

  it('is one-per-type — a later registration for the same type wins (last-wins, like the field-type registry)', () => {
    const a = () => {}
    const b = () => {}
    registerFieldPopulator('relation', a)
    registerFieldPopulator('relation', b)
    expect(getFieldPopulator('relation')).toBe(b)
  })

  it('clearFieldPopulators empties the registry', () => {
    registerFieldPopulator('link', () => {})
    clearFieldPopulators()
    expect(getFieldPopulator('link')).toBeUndefined()
  })
})
