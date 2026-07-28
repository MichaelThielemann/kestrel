import { describe, it, expect } from 'vitest'
import { regenerateBlockIds } from './block-ids'

// A deterministic id source so assertions are exact: n0, n1, n2, … in traversal order.
function seqGen() {
  let i = 0
  return () => `n${i++}`
}

// Collect every `id` in a block tree (root + all slots) for disjointness assertions.
function collectIds(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return []
  const out: string[] = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const n = node as { id?: string; slots?: Record<string, unknown> }
    if (typeof n.id === 'string') out.push(n.id)
    if (n.slots) for (const arr of Object.values(n.slots)) out.push(...collectIds(arr))
  }
  return out
}

describe('regenerateBlockIds', () => {
  it('re-mints ids at every depth (root + nested slots)', () => {
    const src = [
      { id: 'a', type: 'hero', props: { title: 'Hi' } },
      {
        id: 'b', type: 'wrap', props: {},
        slots: {
          default: [
            { id: 'c', type: 'text', props: { body: 'x' } },
            { id: 'd', type: 'wrap', props: {}, slots: { default: [{ id: 'e', type: 'text', props: {} }] } },
          ],
        },
      },
    ]
    const out = regenerateBlockIds(src, seqGen()) as typeof src
    // Every id is fresh and none of the source ids survive anywhere in the tree.
    const outIds = collectIds(out)
    const srcIds = collectIds(src)
    expect(outIds).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
    for (const id of srcIds) expect(outIds).not.toContain(id)
  })

  it('produces ids all disjoint from the source under the real (random) generator', () => {
    const src = [
      { id: 'a', type: 'wrap', props: {}, slots: { default: [{ id: 'b', type: 'text', props: {} }] } },
    ]
    const out = regenerateBlockIds(src)
    const outIds = collectIds(out)
    expect(new Set(outIds).size).toBe(2) // both unique
    for (const id of ['a', 'b']) expect(outIds).not.toContain(id)
  })

  it('preserves type / props / slot structure verbatim', () => {
    const src = [
      { id: 'a', type: 'hero', props: { title: 'Hello', nested: { n: 1 }, list: [1, 2] }, slots: { body: [{ id: 'b', type: 'p', props: { text: 'x' } }] } },
    ]
    const out = regenerateBlockIds(src, seqGen()) as Array<Record<string, unknown>>
    expect(out[0]!.type).toBe('hero')
    expect(out[0]!.props).toEqual({ title: 'Hello', nested: { n: 1 }, list: [1, 2] })
    const slots = out[0]!.slots as { body: Array<Record<string, unknown>> }
    expect(slots.body[0]!.type).toBe('p')
    expect(slots.body[0]!.props).toEqual({ text: 'x' })
  })

  it('deep-clones props (no shared reference with the source)', () => {
    const src = [{ id: 'a', type: 'hero', props: { nested: { n: 1 } } }]
    const out = regenerateBlockIds(src, seqGen()) as Array<{ props: { nested: { n: number } } }>
    expect(out[0]!.props).not.toBe(src[0]!.props)
    expect(out[0]!.props.nested).not.toBe(src[0]!.props.nested)
    out[0]!.props.nested.n = 99
    expect(src[0]!.props.nested.n).toBe(1) // mutating the copy never touches the source
  })

  it('is deterministic under an injected genId', () => {
    const src = [{ id: 'a', type: 'x', props: {} }, { id: 'b', type: 'y', props: {} }]
    expect(collectIds(regenerateBlockIds(src, seqGen()))).toEqual(['n0', 'n1'])
    expect(collectIds(regenerateBlockIds(src, seqGen()))).toEqual(['n0', 'n1'])
  })

  it('passes a non-array / empty content through untouched', () => {
    expect(regenerateBlockIds([])).toEqual([])
    expect(regenerateBlockIds(null)).toBe(null)
    expect(regenerateBlockIds(undefined)).toBe(undefined)
    const notArray = { id: 'a' }
    expect(regenerateBlockIds(notArray)).toBe(notArray)
  })

  it('tolerates non-object nodes and non-array slot values', () => {
    const src = [null, 'nope', { id: 'a', type: 'x', props: {}, slots: { default: 'not-an-array' } }]
    const out = regenerateBlockIds(src, seqGen()) as unknown[]
    expect(out[0]).toBe(null)
    expect(out[1]).toBe('nope')
    const node = out[2] as { id: string; slots: { default: string } }
    expect(node.id).toBe('n0')
    expect(node.slots.default).toBe('not-an-array')
  })
})
