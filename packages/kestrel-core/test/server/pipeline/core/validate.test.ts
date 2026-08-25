import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Effect } from 'effect'
import { z } from 'zod'
import { getFieldType } from '../../../../src/server/registries/field-types.js'
import { getBlock, registerBlock } from '../../../../src/server/blocks/registry.js'
import type { FieldDef } from '../../../../src/index.js'
import { applyFieldTransforms, checkConditions, decodeInput, stripGuardedPatchKeys, type TransformLookups } from '../../../../src/server/pipeline/core/validate.js'

// The real field-registry lookups, wired in by the TEST (not the core) — mirrors what
// `pipeline/steps/transform.ts` injects in production, kept out of `core/validate.ts` itself.
const lookups: TransformLookups = {
  getTransform: (type) => getFieldType(type).transform,
  getBlockFields: (blockType) => getBlock(blockType)?.fields,
}

const schema = z.object({
  title: z.string().min(1),
  age: z.number().int().min(0).max(150),
})
const FIELD_KEYS = ['title', 'age']

// Independent of `decodeInput`'s own use of `schema.safeParse` — comparing against a second
// `schema.safeParse` call would only ever agree with itself (same deterministic call, same input) and
// could never catch a real bug in the wrapping. Instead: arbitraries built to satisfy the schema BY
// CONSTRUCTION must always decode; arbitraries built to violate it BY CONSTRUCTION (wrong types, not
// merely out-of-range) must always fail, with issues that point at real field keys.
describe('decodeInput — decode∘encode agreement with the collection schema', () => {
  it('schema-shaped input always decodes successfully, with every field intact', () => {
    fc.assert(fc.property(fc.record({ title: fc.string({ minLength: 1 }), age: fc.integer({ min: 0, max: 150 }) }), (body) => {
      const exit = Effect.runSyncExit(decodeInput(schema, body))
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') {
        expect(exit.value.title).toBe(body.title)
        expect(exit.value.age).toBe(body.age)
      }
    }))
  })

  it('a deliberately disjoint (wrong-type) body always fails, with every issue naming a real field key', () => {
    fc.assert(fc.property(fc.record({ title: fc.integer(), age: fc.string() }), (body) => {
      const exit = Effect.runSyncExit(decodeInput(schema, body))
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error.issues.length).toBeGreaterThan(0)
        for (const issue of exit.cause.error.issues) expect(FIELD_KEYS).toContain(issue.path[0])
      }
    }))
  })

  it('reports every issue, not just the first, for a body that fails on multiple fields', () => {
    const exit = Effect.runSyncExit(decodeInput(schema, { title: '', age: -1 }))
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
      expect(exit.cause.error.issues.length).toBeGreaterThanOrEqual(2)
      expect(exit.cause.error.issues.map((i) => i.path)).toEqual([['title'], ['age']])
    }
  })
})

describe('checkConditions', () => {
  it('no checker is always a no-op', () => {
    fc.assert(fc.property(fc.object(), (record) => {
      const exit = Effect.runSyncExit(checkConditions(undefined, record))
      expect(exit._tag).toBe('Success')
    }))
  })

  it('a checker that itself returns undefined is a no-op (optional-chained twice)', () => {
    const exit = Effect.runSyncExit(checkConditions(() => undefined, {}))
    expect(exit._tag).toBe('Success')
  })

  it('any non-empty issue list fails with exactly those issues; an empty one always succeeds', () => {
    fc.assert(fc.property(fc.array(fc.record({ path: fc.array(fc.string()), message: fc.string() })), (issues) => {
      const exit = Effect.runSyncExit(checkConditions(() => ({ issues }), {}))
      expect(exit._tag).toBe(issues.length > 0 ? 'Failure' : 'Success')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error.issues).toEqual(issues.map((i) => ({ path: i.path, message: i.message, code: undefined })))
      }
    }))
  })

  it('passes the record through to the checker unchanged', () => {
    const record = { a: 1, b: 'x' }
    let received: unknown
    Effect.runSync(checkConditions((r) => { received = r; return { issues: [] } }, record))
    expect(received).toBe(record)
  })
})

describe('stripGuardedPatchKeys', () => {
  it('never lets id/createdAt/translationGroup/singletonKey survive, and keeps everything else', () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (patch) => {
      const out = stripGuardedPatchKeys(patch)
      for (const key of ['id', 'createdAt', 'translationGroup', 'singletonKey']) expect(key in out).toBe(false)
      for (const [key, value] of Object.entries(patch)) {
        if (['id', 'createdAt', 'translationGroup', 'singletonKey'].includes(key)) continue
        expect(out[key]).toEqual(value)
      }
    }))
  })
})

describe('applyFieldTransforms — field dispatch', () => {
  const fields = {
    title: { type: 'text', required: true },
    slug: { type: 'slug', options: { from: 'title' } },
  } as unknown as Record<string, FieldDef>

  it('CREATE (all): generates an OMITTED slug from the source field', () => {
    const v: Record<string, unknown> = { title: 'Hello World' }
    const out = applyFieldTransforms(lookups, fields, undefined, v, v, true)
    expect(out.slug).toBe('hello-world')
  })

  it('never mutates the `values`/`record` objects it was given', () => {
    const v: Record<string, unknown> = { title: 'Hello World' }
    const before = { ...v }
    applyFieldTransforms(lookups, fields, undefined, v, v, true)
    expect(v).toEqual(before)
  })

  it('UPDATE (patched-only): does NOT touch an untransformed field not present in `values`', () => {
    const v: Record<string, unknown> = { title: 'New Title' }
    const out = applyFieldTransforms(lookups, fields, undefined, v, { title: 'New Title', slug: 'existing-slug' }, false)
    expect('slug' in out).toBe(false)
  })

  it('UPDATE (patched-only): DOES re-derive a field present in `values`, from the merged record', () => {
    const v: Record<string, unknown> = { slug: '' }
    const out = applyFieldTransforms(lookups, fields, undefined, v, { title: 'Source Title', slug: '' }, false)
    expect(out.slug).toBe('source-title')
  })

  it('a field with no registered transform is left untouched', () => {
    const plain = { title: { type: 'text' } } as unknown as Record<string, FieldDef>
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.string()), (record) => {
      const v = { ...record }
      const out = applyFieldTransforms(lookups, plain, undefined, v, v, true)
      expect(out).toEqual(record)
    }))
  })

  it('is idempotent: transforming an already-transformed record changes nothing further', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), (title) => {
      const v: Record<string, unknown> = { title }
      const once = applyFieldTransforms(lookups, fields, undefined, v, v, true)
      const twice = applyFieldTransforms(lookups, fields, undefined, once, once, true)
      expect(twice).toEqual(once)
    }))
  })

  it('CREATE: a later field\'s transform sees an EARLIER field\'s already-transformed value (record===values chains through `next`, not the frozen original)', () => {
    const chained = {
      title: { type: 'text' },
      slug: { type: 'slug', options: { from: 'title' } },
      slug2: { type: 'slug', options: { from: 'slug' } },
    } as unknown as Record<string, FieldDef>
    const v: Record<string, unknown> = { title: 'Hello World' }
    const out = applyFieldTransforms(lookups, chained, undefined, v, v, true)
    expect(out.slug).toBe('hello-world')
    // slug2 derives from `slug`'s OWN just-computed value, not from the original (absent) input.
    expect(out.slug2).toBe('hello-world')
  })
})

describe('applyFieldTransforms — repeater recursion', () => {
  const fields = {
    items: { type: 'repeater', options: { fields: {
      title: { type: 'text' },
      slug: { type: 'slug', options: { from: 'title' } },
    } } },
  } as unknown as Record<string, FieldDef>

  it('runs the nested transform on every entry', () => {
    const v: Record<string, unknown> = { items: [{ title: 'One' }, { title: 'Two', slug: 'x' }] }
    const out = applyFieldTransforms(lookups, fields, undefined, v, v, true)
    const items = out.items as Record<string, unknown>[]
    expect(items[0]!.slug).toBe('one')
    // Nested transforms always run (no `all`/patch concept inside a repeater entry) — an explicit
    // value is slugified as given, not re-derived from the title.
    expect(items[1]!.slug).toBe('x')
  })

  it('skips a non-array repeater value without throwing', () => {
    const v: Record<string, unknown> = { items: 'not-an-array' }
    let out: Record<string, unknown> = {}
    expect(() => { out = applyFieldTransforms(lookups, fields, undefined, v, v, true) }).not.toThrow()
    expect(out.items).toBe('not-an-array')
  })

  it('skips a non-object entry inside the array', () => {
    const v: Record<string, unknown> = { items: [null, 'x', 42] }
    expect(() => applyFieldTransforms(lookups, fields, undefined, v, v, true)).not.toThrow()
  })

  it('recurses into a repeater nested inside a repeater entry', () => {
    const nestedFields = {
      groups: { type: 'repeater', options: { fields: {
        items: { type: 'repeater', options: { fields: { title: { type: 'text' }, slug: { type: 'slug', options: { from: 'title' } } } } },
      } } },
    } as unknown as Record<string, FieldDef>
    const v: Record<string, unknown> = { groups: [{ items: [{ title: 'Deep' }] }] }
    const out = applyFieldTransforms(lookups, nestedFields, undefined, v, v, true)
    const groups = out.groups as { items: Record<string, unknown>[] }[]
    expect(groups[0]!.items[0]!.slug).toBe('deep')
  })

  it('a repeater field with no entries at all (key absent) is a no-op, not a throw', () => {
    const v: Record<string, unknown> = {}
    expect(() => applyFieldTransforms(lookups, fields, undefined, v, v, true)).not.toThrow()
  })

  it('skips a non-object/falsy entry inside a NESTED repeater (repeater-inside-repeater)', () => {
    const nestedFields = {
      groups: { type: 'repeater', options: { fields: {
        items: { type: 'repeater', options: { fields: { title: { type: 'text' }, slug: { type: 'slug', options: { from: 'title' } } } } },
      } } },
    } as unknown as Record<string, FieldDef>
    const v: Record<string, unknown> = { groups: [{ items: [null, 'x', 42, { title: 'Real' }] }] }
    const out = applyFieldTransforms(lookups, nestedFields, undefined, v, v, true)
    const groups = out.groups as { items: unknown[] }[]
    expect(groups[0]!.items[0]).toBeNull()
    expect(groups[0]!.items[1]).toBe('x')
    expect(groups[0]!.items[2]).toBe(42)
    expect((groups[0]!.items[3] as Record<string, unknown>).slug).toBe('real')
  })
})

describe('applyFieldTransforms — block recursion', () => {
  registerBlock({
    name: 'hero',
    fields: { title: { type: 'text' } as FieldDef, slug: { type: 'slug', options: { from: 'title' } } as unknown as FieldDef },
    slots: ['body'],
  })
  registerBlock({
    name: 'plain',
    fields: { text: { type: 'text' } as FieldDef },
    slots: ['body'],
  })
  const noFields = {} as Record<string, FieldDef>

  it('blocksEnabled=false never touches `content`, even when present', () => {
    const v: Record<string, unknown> = { content: [{ type: 'hero', props: { title: 'X' } }] }
    const out = applyFieldTransforms(lookups, noFields, false, v, v, true)
    const content = out.content as { props: Record<string, unknown> }[]
    expect(content[0]!.props.slug).toBeUndefined()
  })

  it('blocksEnabled=true, all=true: transforms every block\'s props', () => {
    const v: Record<string, unknown> = { content: [{ type: 'hero', props: { title: 'X' } }] }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    const content = out.content as { props: Record<string, unknown> }[]
    expect(content[0]!.props.slug).toBe('x')
  })

  it('blocksEnabled=true, all=false: only runs when `content` is present in `values`', () => {
    const untouched: Record<string, unknown> = { other: 1 }
    const untouchedOut = applyFieldTransforms(lookups, noFields, true, untouched, untouched, false)
    expect('content' in untouchedOut).toBe(false)

    const touched: Record<string, unknown> = { content: [{ type: 'hero', props: { title: 'X' } }] }
    const touchedOut = applyFieldTransforms(lookups, noFields, true, touched, touched, false)
    const content = touchedOut.content as { props: Record<string, unknown> }[]
    expect(content[0]!.props.slug).toBe('x')
  })

  it('a truthy but non-object entry in `content` is skipped, not treated as a block', () => {
    const v: Record<string, unknown> = { content: ['a plain string entry'] }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    expect(out.content).toEqual(['a plain string entry'])
  })

  it('recurses into slots, and skips an unknown block type + a block with no props', () => {
    const v: Record<string, unknown> = {
      content: [
        { type: 'unknown-block', props: { x: 1 } },
        { props: { x: 1 } }, // no `type`
        { type: 'plain', slots: { body: [{ type: 'hero', props: { title: 'Nested' } }] } },
      ],
    }
    let out: Record<string, unknown> = {}
    expect(() => { out = applyFieldTransforms(lookups, noFields, true, v, v, true) }).not.toThrow()
    const content = out.content as { slots?: { body: { props: Record<string, unknown> }[] } }[]
    expect(content[2]!.slots!.body[0]!.props.slug).toBe('nested')
  })

  it('a non-array `content` value is left alone without throwing', () => {
    const v: Record<string, unknown> = { content: 'not-blocks' }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    expect(out.content).toBe('not-blocks')
  })

  it('an empty `content` array is a no-op', () => {
    const v: Record<string, unknown> = { content: [] }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    expect(out.content).toEqual([])
  })

  it('a falsy entry in `content` is skipped', () => {
    const v: Record<string, unknown> = { content: [null, undefined, 0, false] }
    expect(() => applyFieldTransforms(lookups, noFields, true, v, v, true)).not.toThrow()
  })

  it('a `type` that is not a string never looks up a block def', () => {
    const v: Record<string, unknown> = { content: [{ type: 42, props: { title: 'X' } }] }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    const content = out.content as { props: Record<string, unknown> }[]
    expect(content[0]!.props).toEqual({ title: 'X' })
  })

  it('a known block whose `props` is not an object is left untouched', () => {
    const v: Record<string, unknown> = { content: [{ type: 'hero', props: 'not-an-object' }] }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    const content = out.content as { props: unknown }[]
    expect(content[0]!.props).toBe('not-an-object')
  })

  it('a known block with no `props` at all is left untouched, not thrown on', () => {
    const v: Record<string, unknown> = { content: [{ type: 'hero' }] }
    expect(() => applyFieldTransforms(lookups, noFields, true, v, v, true)).not.toThrow()
  })

  it('`slots` that is present but not an object is never recursed into, and passes through unchanged', () => {
    const v: Record<string, unknown> = { content: [{ type: 'plain', props: { text: 'x' }, slots: 'not-an-object' }] }
    const out = applyFieldTransforms(lookups, noFields, true, v, v, true)
    const content = out.content as { slots: unknown }[]
    expect(content[0]!.slots).toBe('not-an-object')
  })

  it('a block with no `slots` key at all is a no-op for recursion, not a throw', () => {
    const v: Record<string, unknown> = { content: [{ type: 'plain', props: { text: 'x' } }] }
    expect(() => applyFieldTransforms(lookups, noFields, true, v, v, true)).not.toThrow()
  })
})
