import { describe, it, expect } from 'vitest'
import { evaluateCondition, isFieldVisible, isEmptyValue } from './condition'

describe('evaluateCondition', () => {
  const scope = { type: 'image', count: 3, featured: true, title: 'Hello', tags: ['a', 'b'], blank: '' }

  it('is-shorthand: strict equality, type-sensitive', () => {
    expect(evaluateCondition({ field: 'type', is: 'image' }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'type', is: 'video' }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'featured', is: true }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'featured', is: 1 as never }, scope)).toBe(false)
  })

  it('bare rule = presence (non-empty)', () => {
    expect(evaluateCondition({ field: 'title' }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'blank' }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'missing' }, scope)).toBe(false)
  })

  it('op: eq / ne', () => {
    expect(evaluateCondition({ field: 'type', op: { eq: 'image' } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'type', op: { ne: 'image' } }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'type', op: { ne: 'video' } }, scope)).toBe(true)
  })

  it('op: gt/gte/lt/lte over numbers and strings; type mismatch fails', () => {
    expect(evaluateCondition({ field: 'count', op: { gt: 2 } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'count', op: { gte: 3, lt: 4 } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'count', op: { lt: 3 } }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'title', op: { gt: 'A' } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'count', op: { gt: '2' } }, scope)).toBe(false)
  })

  it('op: in / notIn (strict membership)', () => {
    expect(evaluateCondition({ field: 'type', op: { in: ['image', 'video'] } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'type', op: { in: ['video'] } }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'type', op: { notIn: ['video'] } }, scope)).toBe(true)
  })

  it('op: regexp (case-sensitive); non-string dependency fails', () => {
    expect(evaluateCondition({ field: 'title', op: { regexp: '^Hell' } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'title', op: { regexp: '^hell' } }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'count', op: { regexp: '3' } }, scope)).toBe(false)
  })

  it('op: empty true/false', () => {
    expect(evaluateCondition({ field: 'blank', op: { empty: true } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'title', op: { empty: false } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'tags', op: { empty: true } }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'missing', op: { empty: true } }, scope)).toBe(true)
  })

  it('multiple operator keys are ANDed', () => {
    expect(evaluateCondition({ field: 'count', op: { gte: 3, lte: 3 } }, scope)).toBe(true)
    expect(evaluateCondition({ field: 'count', op: { gte: 3, lte: 2 } }, scope)).toBe(false)
  })

  it('and / or / not combinators', () => {
    expect(evaluateCondition({ and: [{ field: 'type', is: 'image' }, { field: 'featured', is: true }] }, scope)).toBe(true)
    expect(evaluateCondition({ and: [{ field: 'type', is: 'image' }, { field: 'featured', is: false }] }, scope)).toBe(false)
    expect(evaluateCondition({ or: [{ field: 'type', is: 'video' }, { field: 'featured', is: true }] }, scope)).toBe(true)
    expect(evaluateCondition({ or: [] }, scope)).toBe(false)
    expect(evaluateCondition({ not: { field: 'type', is: 'video' } }, scope)).toBe(true)
  })

  it('missing sibling => not matching, never throws', () => {
    expect(evaluateCondition({ field: 'nope', is: 'x' }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'nope', op: { eq: 'x' } }, scope)).toBe(false)
  })

  it('v1 path scope is sibling-only; cross-scope forms are unresolvable (=> not matching)', () => {
    expect(evaluateCondition({ field: './type', is: 'image' }, scope)).toBe(true)
    expect(evaluateCondition({ field: '/type', is: 'image' }, scope)).toBe(false)
    expect(evaluateCondition({ field: '../type', is: 'image' }, scope)).toBe(false)
    expect(evaluateCondition({ field: 'a.b', is: 'image' }, scope)).toBe(false)
  })
})

describe('isFieldVisible', () => {
  it('no condition => always visible', () => {
    expect(isFieldVisible({ type: 'text' } as never, {})).toBe(true)
    expect(isFieldVisible(undefined, {})).toBe(true)
  })
  it('with condition => evaluates against the scope', () => {
    const field = { type: 'text', condition: { field: 'a', is: true } } as never
    expect(isFieldVisible(field, { a: true })).toBe(true)
    expect(isFieldVisible(field, { a: false })).toBe(false)
  })
})

describe('isEmptyValue', () => {
  it('treats null/undefined/""/[] as empty, keeps 0/false/values', () => {
    for (const v of [null, undefined, '', []]) expect(isEmptyValue(v)).toBe(true)
    for (const v of [0, false, 'x', [1], {}]) expect(isEmptyValue(v)).toBe(false)
  })
})
