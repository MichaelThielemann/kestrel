import { describe, it, expect } from 'vitest'
import { resolveFieldLayout, validateFieldLayoutsDeep } from './field-layout'
import type { CollectionDef } from './defineCollection'

describe('resolveFieldLayout', () => {
  it('equal columns: a bare string[] row defaults every track to 1fr', () => {
    expect(resolveFieldLayout([['a', 'b']], ['a', 'b'], 'ctx')).toEqual([
      { kind: 'row', fields: ['a', 'b'], tracks: [1, 1] },
    ])
  })

  it('flex weights: a bare number becomes an fr track', () => {
    expect(resolveFieldLayout([['a|2', 'b|1']], ['a', 'b'], 'ctx')).toEqual([
      { kind: 'row', fields: ['a', 'b'], tracks: [2, 1] },
    ])
    // decimal weights are allowed
    expect(resolveFieldLayout([['a|1.5', 'b']], ['a', 'b'], 'ctx')[0]!.tracks).toEqual([1.5, 1])
  })

  it('CSS lengths/percents pass through, other tracks default to 1fr', () => {
    expect(resolveFieldLayout([['a|30%', 'b']], ['a', 'b'], 'ctx')[0]!.tracks).toEqual(['30%', 1])
    expect(resolveFieldLayout([['a|12rem', 'b|200px']], ['a', 'b'], 'ctx')[0]!.tracks).toEqual(['12rem', '200px'])
    expect(resolveFieldLayout([['a|1fr', 'b|2em']], ['a', 'b'], 'ctx')[0]!.tracks).toEqual([1, '2em'])
  })

  it('a lone string is a full-width row; a lone widthed string yields that single track', () => {
    expect(resolveFieldLayout(['a'], ['a'], 'ctx')).toEqual([{ kind: 'row', fields: ['a'], tracks: [1] }])
    expect(resolveFieldLayout(['a|50%'], ['a'], 'ctx')).toEqual([{ kind: 'row', fields: ['a'], tracks: ['50%'] }])
  })

  it('a group of lone strings is stacked full-width rows; a group of one array is one multi-column row', () => {
    expect(resolveFieldLayout([{ SEO: ['a', 'b'] }], ['a', 'b'], 'ctx')).toEqual([
      { kind: 'group', label: 'SEO', rows: [
        { kind: 'row', fields: ['a'], tracks: [1] },
        { kind: 'row', fields: ['b'], tracks: [1] },
      ] },
    ])
    expect(resolveFieldLayout([{ SEO: [['a', 'b']] }], ['a', 'b'], 'ctx')).toEqual([
      { kind: 'group', label: 'SEO', rows: [{ kind: 'row', fields: ['a', 'b'], tracks: [1, 1] }] },
    ])
  })

  it('mixes rows and groups, and widths inside a group row', () => {
    const nodes = resolveFieldLayout(['title', { Meta: [['a|2', 'b']] }], ['title', 'a', 'b'], 'ctx')
    expect(nodes).toEqual([
      { kind: 'row', fields: ['title'], tracks: [1] },
      { kind: 'group', label: 'Meta', rows: [{ kind: 'row', fields: ['a', 'b'], tracks: [2, 1] }] },
    ])
  })

  it('appends every field missing from the layout as a full-width row, in declaration order', () => {
    expect(resolveFieldLayout([['a', 'b']], ['a', 'b', 'c', 'd'], 'ctx')).toEqual([
      { kind: 'row', fields: ['a', 'b'], tracks: [1, 1] },
      { kind: 'row', fields: ['c'], tracks: [1] },
      { kind: 'row', fields: ['d'], tracks: [1] },
    ])
  })

  it('an empty layout renders one full-width row per field (parity with no layout)', () => {
    expect(resolveFieldLayout([], ['a', 'b'], 'ctx')).toEqual([
      { kind: 'row', fields: ['a'], tracks: [1] },
      { kind: 'row', fields: ['b'], tracks: [1] },
    ])
  })

  it('throws on an unknown field', () => {
    expect(() => resolveFieldLayout(['x'], ['a'], 'ctx')).toThrowError(/unknown field "x"/)
  })

  it('throws on a duplicate field (across rows or within a row)', () => {
    expect(() => resolveFieldLayout(['a', 'a'], ['a'], 'ctx')).toThrowError(/appears more than once/)
    expect(() => resolveFieldLayout([['a', 'a']], ['a'], 'ctx')).toThrowError(/appears more than once/)
  })

  it('throws on more than one "|" in a token', () => {
    expect(() => resolveFieldLayout(['a|2|3'], ['a'], 'ctx')).toThrowError(/more than one "\|"/)
  })

  it('throws on an empty field name', () => {
    expect(() => resolveFieldLayout(['|2'], ['a'], 'ctx')).toThrowError(/empty field name/)
  })

  it('throws on an invalid width (non-allow-listed unit / arbitrary CSS)', () => {
    for (const w of ['10vmin', 'red', '1fr;color:red', 'calc(100%)', 'auto']) {
      expect(() => resolveFieldLayout([`a|${w}`], ['a'], 'ctx')).toThrowError(/invalid width/)
    }
  })

  it('rejects a zero (or negative) weight/length — a 0fr track would collapse the field to a silent sliver', () => {
    for (const w of ['0', '0%', '0px', '0.0', '0fr', '0rem', '0.0fr', '-1']) {
      expect(() => resolveFieldLayout([`a|${w}`], ['a'], 'ctx')).toThrowError(/invalid width/)
    }
    // a sub-1 but positive weight/length is still a real track and is allowed
    expect(resolveFieldLayout([['a|0.5', 'b']], ['a', 'b'], 'ctx')[0]!.tracks).toEqual([0.5, 1])
    expect(resolveFieldLayout([['a|0.5%', 'b']], ['a', 'b'], 'ctx')[0]!.tracks).toEqual(['0.5%', 1])
  })

  it('rejects an overflow weight that parses to Infinity (would serialize to JSON null on the wire)', () => {
    expect(() => resolveFieldLayout([`a|${'9'.repeat(400)}`], ['a'], 'ctx')).toThrowError(/invalid width/)
    expect(() => resolveFieldLayout([`a|${'9'.repeat(400)}fr`], ['a'], 'ctx')).toThrowError(/invalid width/)
  })

  it('throws on an empty row', () => {
    expect(() => resolveFieldLayout([[]], ['a'], 'ctx')).toThrowError(/at least one field/)
  })

  it('throws on a group with no rows or with more than one name', () => {
    expect(() => resolveFieldLayout([{ SEO: [] }], ['a'], 'ctx')).toThrowError(/needs at least one row/)
    expect(() => resolveFieldLayout([{ a: ['a'], b: ['b'] }], ['a', 'b'], 'ctx')).toThrowError(/exactly one name/)
  })

  it('rejects a nested group (one level only)', () => {
    expect(() => resolveFieldLayout([{ SEO: [{ Inner: ['a'] }] }], ['a'], 'ctx')).toThrowError(/may not nest another group/)
  })

  it('rejects a non-string token inside a row', () => {
    expect(() => resolveFieldLayout([[['a']]] as never, ['a'], 'ctx')).toThrowError(/must be a string/)
  })
})

describe('validateFieldLayoutsDeep', () => {
  const coll = (def: Partial<CollectionDef>): CollectionDef =>
    ({ name: 'demo', mode: 'multi', fields: {}, ...def }) as CollectionDef

  it('accepts a valid top-level layout and a valid nested-repeater layout', () => {
    expect(() => validateFieldLayoutsDeep(coll({
      fields: {
        title: { type: 'text' },
        rows: { type: 'repeater', options: { fields: { a: { type: 'text' }, b: { type: 'text' } }, fieldLayout: [['a', 'b']] } },
      },
      fieldLayout: [['title', 'rows']],
    }))).not.toThrow()
  })

  it('throws on a bad top-level layout', () => {
    expect(() => validateFieldLayoutsDeep(coll({ fields: { a: { type: 'text' } }, fieldLayout: ['nope'] })))
      .toThrowError(/collection "demo".*unknown field "nope"/)
  })

  it('throws on a bad layout inside a (deeply) nested repeater, naming the repeater path', () => {
    expect(() => validateFieldLayoutsDeep(coll({
      fields: {
        outer: { type: 'repeater', options: { fields: {
          inner: { type: 'repeater', options: { fields: { a: { type: 'text' } }, fieldLayout: ['ghost'] } },
        } } },
      },
    }))).toThrowError(/repeater "outer" > repeater "inner".*unknown field "ghost"/)
  })
})
