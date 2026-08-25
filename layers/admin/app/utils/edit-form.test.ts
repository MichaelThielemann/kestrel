import { describe, it, expect } from 'vitest'
import { asFieldDef, initialValues, mapServerErrors, parseBlockErrors, reconcileBlockErrors, reconcileDeadRefs, readFetchError, valuesEqual } from './edit-form'
import type { SerializedField } from '@kestrel/core'
import { registerFieldEmpty } from '../../../ui/app/utils/field-empty'

function f(partial: Partial<SerializedField> & Pick<SerializedField, 'type'>): SerializedField {
  return { required: false, unique: false, ...partial }
}

describe('initialValues', () => {
  it('derives a type-appropriate empty for each field type', () => {
    const fields: Record<string, SerializedField> = {
      title: f({ type: 'text' }),
      count: f({ type: 'number' }),
      live: f({ type: 'boolean' }),
      data: f({ type: 'json' }),
      when: f({ type: 'datetime' }),
      to: f({ type: 'link' }),
      body: f({ type: 'richtext' }),
      tags: f({ type: 'choice', options: { multiple: true, choices: [] } }),
      status: f({ type: 'choice', options: { multiple: false, choices: [] } }),
      authors: f({ type: 'relation', relation: { collection: 'users', many: true } }),
      author: f({ type: 'relation', relation: { collection: 'users', many: false } }),
      rows: f({ type: 'repeater', options: { fields: {} } }),
      cover: f({ type: 'media' }),
    }
    expect(initialValues(fields)).toEqual({
      title: '',
      count: null,
      live: false,
      data: null,
      when: null,
      to: null,
      body: null,
      tags: [],
      status: null,
      authors: [],
      author: null,
      rows: [],
      cover: null,
    })
  })

  it('seeds multi-media as [] and consults a registered custom-type empty', () => {
    registerFieldEmpty('tags', () => [])
    const fields: Record<string, SerializedField> = {
      imgs: f({ type: 'media', options: { multiple: true } }),
      cover: f({ type: 'media' }),
      tags: f({ type: 'tags' }), // custom array-backed type with a registered empty
      swatch: f({ type: 'color' }), // custom scalar type, no registered empty → null
    }
    expect(initialValues(fields)).toEqual({ imgs: [], cover: null, tags: [], swatch: null })
  })

  it('uses a present default (even when falsy or null) over the type-empty', () => {
    const fields: Record<string, SerializedField> = {
      count: f({ type: 'number', default: 0 }),
      title: f({ type: 'text', default: 'Untitled' }),
      blank: f({ type: 'text', default: null }),
      live: f({ type: 'boolean', default: true }),
    }
    expect(initialValues(fields)).toEqual({ count: 0, title: 'Untitled', blank: null, live: true })
  })

  it('clones object/array defaults so a widget cannot mutate the schema', () => {
    const shared = ['a']
    const fields: Record<string, SerializedField> = {
      tags: f({ type: 'choice', options: { multiple: true, choices: [] }, default: shared }),
    }
    const values = initialValues(fields)
    ;(values.tags as string[]).push('b')
    expect(shared).toEqual(['a'])
  })
})

describe('asFieldDef', () => {
  it('returns the same object (narrowing cast only)', () => {
    const field = f({ type: 'text' })
    expect(asFieldDef(field)).toBe(field)
  })
})

describe('parseBlockErrors', () => {
  const content = [
    { id: 'b0', type: 'hero', props: {} },
    { id: 'b1', type: 'prose', props: {} },
    { id: 'b2', type: 'prose', props: {} },
  ]

  it('resolves content[i].props.field issues to the block id, not its position', () => {
    expect(parseBlockErrors([
      { path: ['content', 0, 'props', 'heading'], message: 'Required' },
      { path: ['content', 2, 'props', 'body'], message: 'Invalid' },
    ], content)).toEqual({ b0: { heading: 'Required' }, b2: { body: 'Invalid' } })
  })

  it('keeps the first message per block field and ignores unrelated paths', () => {
    expect(parseBlockErrors([
      { path: ['content', 0, 'props', 'heading'], message: 'First' },
      { path: ['content', 0, 'props', 'heading'], message: 'Second' },
      { path: ['title'], message: 'nope' },
      { path: ['content', 0, 'type'], message: 'block-level' },
    ], content)).toEqual({ b0: { heading: 'First' } })
  })

  it('skips issues whose block index has no resolvable id', () => {
    expect(parseBlockErrors([{ path: ['content', 5, 'props', 'heading'], message: 'Required' }], content)).toEqual({})
    expect(parseBlockErrors([{ path: ['content', 0, 'props', 'heading'], message: 'Required' }], [{ type: 'hero', props: {} }])).toEqual({})
  })

  it('returns an empty map for no issues', () => {
    expect(parseBlockErrors([], content)).toEqual({})
    expect(parseBlockErrors(undefined, content)).toEqual({})
  })

  const nested = [
    { id: 'b0', type: 'hero', props: {}, slots: { default: [
      { id: 'c0', type: 'prose', props: {} },
      { id: 'c1', type: 'hero', props: {}, slots: { default: [
        { id: 'g0', type: 'prose', props: {} },
      ] } },
    ] } },
  ]

  it('resolves a slot-nested block issue to the nested block id', () => {
    expect(parseBlockErrors([
      { path: ['content', 0, 'slots', 'default', 0, 'props', 'body'], message: 'Required' },
      { path: ['content', 0, 'slots', 'default', 1, 'props', 'heading'], message: 'Bad' },
    ], nested)).toEqual({ c0: { body: 'Required' }, c1: { heading: 'Bad' } })
  })

  it('resolves a deeply nested (slot-in-slot) block issue', () => {
    expect(parseBlockErrors([
      { path: ['content', 0, 'slots', 'default', 1, 'slots', 'default', 0, 'props', 'body'], message: 'Required' },
    ], nested)).toEqual({ g0: { body: 'Required' } })
  })

  it('skips a slot path whose nested index or slot name has no resolvable block', () => {
    expect(parseBlockErrors([
      { path: ['content', 0, 'slots', 'default', 9, 'props', 'body'], message: 'x' },
      { path: ['content', 0, 'slots', 'missing', 0, 'props', 'body'], message: 'y' },
    ], nested)).toEqual({})
  })
})

describe('reconcileBlockErrors', () => {
  const errs = { h: { heading: 'Required' }, p: { body: 'Invalid' } }
  const base = () => [
    { id: 'h', type: 'hero', props: { heading: '' } },
    { id: 'p', type: 'prose', props: { body: '' } },
  ]

  it('preserves every error across a pure reorder', () => {
    const prev = base()
    const next = [prev[1]!, prev[0]!]
    expect(reconcileBlockErrors(errs, prev, next)).toEqual(errs)
  })

  it("clears a block's errors when its props change (an edit), keeping the others", () => {
    const prev = base()
    const next = [{ id: 'h', type: 'hero', props: { heading: 'set' } }, prev[1]!]
    expect(reconcileBlockErrors(errs, prev, next)).toEqual({ p: { body: 'Invalid' } })
  })

  it('reconciles PER-FIELD: editing one field keeps a still-invalid sibling field of the same block', () => {
    const errs2 = { h: { heading: 'Required', subtitle: 'Required' } }
    const prev = [{ id: 'h', type: 'hero', props: { heading: '', subtitle: '' } }]
    const next = [{ id: 'h', type: 'hero', props: { heading: 'set', subtitle: '' } }]
    // editing `heading` clears only its own stale message; the still-empty `subtitle` keeps its error
    expect(reconcileBlockErrors(errs2, prev, next)).toEqual({ h: { subtitle: 'Required' } })
  })

  it('drops errors for removed blocks and never invents them for added ones', () => {
    const prev = base()
    const next = [prev[0]!, { id: 'x', type: 'prose', props: { body: '' } }]
    expect(reconcileBlockErrors(errs, prev, next)).toEqual({ h: { heading: 'Required' } })
  })

  it('returns an empty map when there is nothing to carry', () => {
    expect(reconcileBlockErrors({}, base(), base())).toEqual({})
  })

  it('keeps a nested block error across a reorder within its slot', () => {
    const prev = [{ id: 'h', type: 'hero', props: { heading: 'top' }, slots: { default: [
      { id: 'c0', type: 'prose', props: { body: '' } },
      { id: 'c1', type: 'hero', props: { heading: '' } },
    ] } }]
    const next = [{ id: 'h', type: 'hero', props: { heading: 'top' }, slots: { default: [
      { id: 'c1', type: 'hero', props: { heading: '' } },
      { id: 'c0', type: 'prose', props: { body: '' } },
    ] } }]
    expect(reconcileBlockErrors({ c1: { heading: 'Required' } }, prev, next)).toEqual({ c1: { heading: 'Required' } })
  })

  it("clears a nested block error once its own props change", () => {
    const prev = [{ id: 'h', type: 'hero', props: { heading: 'top' }, slots: { default: [
      { id: 'c1', type: 'hero', props: { heading: '' } },
    ] } }]
    const next = [{ id: 'h', type: 'hero', props: { heading: 'top' }, slots: { default: [
      { id: 'c1', type: 'hero', props: { heading: 'set' } },
    ] } }]
    expect(reconcileBlockErrors({ c1: { heading: 'Required' } }, prev, next)).toEqual({})
  })

  it('drops a nested block error when the nested block is removed', () => {
    const prev = [{ id: 'h', type: 'hero', props: { heading: 'top' }, slots: { default: [
      { id: 'c1', type: 'hero', props: { heading: '' } },
    ] } }]
    const next = [{ id: 'h', type: 'hero', props: { heading: 'top' }, slots: { default: [] } }]
    expect(reconcileBlockErrors({ c1: { heading: 'Required' } }, prev, next)).toEqual({})
  })
})

describe('reconcileDeadRefs', () => {
  const refs = [
    { field: 'image', blockId: 'h', collection: 'media', id: 1, reason: 'missing' as const },
    { field: 'title', collection: 'pages', id: 2, reason: 'missing' as const }, // root-level (no blockId)
  ]
  const base = () => [{ id: 'h', type: 'hero', props: { image: 5 } }]

  it('clears a block dead-ref once the offending field is swapped out (an edit)', () => {
    const prev = base()
    const next = [{ id: 'h', type: 'hero', props: { image: 9 } }]
    expect(reconcileDeadRefs(refs, prev, next)).toEqual([refs[1]])
  })

  it('preserves a block dead-ref across a pure reorder', () => {
    const prev = [...base(), { id: 'p', type: 'prose', props: { body: '' } }]
    const next = [prev[1]!, prev[0]!]
    expect(reconcileDeadRefs(refs, prev, next)).toEqual(refs)
  })

  it('drops a block dead-ref when its block is removed', () => {
    expect(reconcileDeadRefs(refs, base(), [])).toEqual([refs[1]])
  })

  it('leaves root-level dead refs (no blockId) untouched — unrelated to content changes', () => {
    expect(reconcileDeadRefs([refs[1]!], base(), base())).toEqual([refs[1]])
  })
})

describe('readFetchError', () => {
  it('extracts nested Zod issues (err.data.data) plus top-level status', () => {
    const e = {
      statusCode: 400,
      statusMessage: 'Validation failed',
      data: { statusMessage: 'Validation failed', data: [{ path: ['title'], message: 'Required' }] },
    }
    expect(readFetchError(e)).toEqual({
      statusCode: 400,
      statusMessage: 'Validation failed',
      issues: [{ path: ['title'], message: 'Required' }],
    })
  })

  it('falls back to err.data when not nested, and to empty issues otherwise', () => {
    expect(readFetchError({ statusCode: 409, statusMessage: 'Conflict' }).issues).toEqual([])
    expect(readFetchError({ data: [{ path: ['x'], message: 'm' }] }).issues).toEqual([{ path: ['x'], message: 'm' }])
  })

  it('prefers the BODY statusMessage — HTTP/2 has no reason phrase, so statusText arrives empty', () => {
    const e = { statusCode: 500, statusMessage: '', data: { statusMessage: 'Redirects saved but not published' } }
    expect(readFetchError(e).statusMessage).toBe('Redirects saved but not published')
  })

  it('still reads the response statusText when the body carries none', () => {
    expect(readFetchError({ statusCode: 409, statusMessage: 'Conflict' }).statusMessage).toBe('Conflict')
  })

  it('surfaces a non-issue data payload so the caller can act on it', () => {
    expect(readFetchError({ statusCode: 500, data: { savedUpdatedAt: 1234 } }).data).toEqual({ savedUpdatedAt: 1234 })
    expect(readFetchError({ statusCode: 400, data: [{ path: ['x'], message: 'm' }] }).data).toBeUndefined()
  })
})

describe('mapServerErrors', () => {
  it('maps issues by path[0] to fields and empty-path to a form error', () => {
    expect(
      mapServerErrors([
        { path: ['title'], message: 'Required' },
        { path: [], message: 'bad' },
      ]),
    ).toEqual({ fields: { title: 'Required' }, form: 'bad' })
  })

  it('keeps the first message per field and the first form-level message', () => {
    expect(
      mapServerErrors([
        { path: ['title'], message: 'First' },
        { path: ['title'], message: 'Second' },
        { path: [], message: 'form-1' },
        { path: [], message: 'form-2' },
      ]),
    ).toEqual({ fields: { title: 'First' }, form: 'form-1' })
  })

  it('omits the form key when there is no form-level issue', () => {
    expect(mapServerErrors([{ path: ['body'], message: 'Invalid' }])).toEqual({ fields: { body: 'Invalid' } })
  })

  it('coerces a numeric path head and tolerates an empty issue list', () => {
    expect(mapServerErrors([{ path: [0], message: 'x' }])).toEqual({ fields: { 0: 'x' } })
    expect(mapServerErrors([])).toEqual({ fields: {} })
  })
})

describe('valuesEqual', () => {
  it('compares primitives', () => {
    expect(valuesEqual('a', 'a')).toBe(true)
    expect(valuesEqual(1, 1)).toBe(true)
    expect(valuesEqual(true, false)).toBe(false)
    expect(valuesEqual('a', 'b')).toBe(false)
    expect(valuesEqual(null, null)).toBe(true)
    expect(valuesEqual(null, '')).toBe(false)
  })

  it('compares arrays by order and length', () => {
    expect(valuesEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(valuesEqual([1, 2, 3], [3, 2, 1])).toBe(false)
    expect(valuesEqual([], [])).toBe(true)
  })

  it('compares datetime ranges and link values structurally', () => {
    expect(valuesEqual({ start: '2026-01-01', end: '2026-02-01' }, { start: '2026-01-01', end: '2026-02-01' })).toBe(true)
    expect(valuesEqual({ start: '2026-01-01', end: '2026-02-01' }, { start: '2026-01-01', end: '2026-03-01' })).toBe(false)
    expect(valuesEqual({ type: 'internal', collection: 'posts', id: 1 }, { type: 'internal', collection: 'posts', id: 1 })).toBe(true)
    expect(valuesEqual({ type: 'external', url: 'a' }, { type: 'external', url: 'b' })).toBe(false)
  })

  it('compares repeater rows (arrays of objects) deeply', () => {
    const a = [{ id: 'r1', value: { label: 'x' } }, { id: 'r2', value: { label: 'y' } }]
    const b = [{ id: 'r1', value: { label: 'x' } }, { id: 'r2', value: { label: 'y' } }]
    const c = [{ id: 'r1', value: { label: 'x' } }, { id: 'r2', value: { label: 'z' } }]
    expect(valuesEqual(a, b)).toBe(true)
    expect(valuesEqual(a, c)).toBe(false)
  })

  it('treats arrays and objects with different key sets as unequal', () => {
    expect(valuesEqual([1, 2], { 0: 1, 1: 2 })).toBe(false)
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(valuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false)
  })
})
