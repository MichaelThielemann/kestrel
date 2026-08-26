import { describe, it, expect } from 'vitest'
import type { SerializedBlock } from '@michaelthielemann/kestrel-core'
import {
  type BlockRow,
  blankBlock,
  cloneBlockTree,
  findInTree,
  updatePropById,
  removeById,
  removalRetarget,
  moveById,
  duplicateById,
  addBlock,
  errorBearingIds,
} from './block-tree'

const schemas = {
  hero: { name: 'hero', label: 'Hero', slots: ['default'], fields: { heading: { type: 'text', required: true }, sub: { type: 'text' } } },
  prose: { name: 'prose', label: 'Prose', fields: { body: { type: 'text' } } },
} as unknown as Record<string, SerializedBlock>

function ids() {
  let n = 0
  return () => `n${n++}`
}

function fixture(): BlockRow[] {
  return [
    { id: 'a', type: 'hero', props: { heading: 'A' }, slots: { default: [{ id: 'a1', type: 'prose', props: { body: 'x' } }] } },
    { id: 'b', type: 'prose', props: { body: 'B' } },
  ]
}

describe('updatePropById — structural sharing (identity preserved off the edit path)', () => {
  it('keeps untouched slot-bearing branches by reference; only the edited path is rebuilt', () => {
    const c = { id: 'c', type: 'hero', props: { heading: 'C' }, slots: { default: [{ id: 'c1', type: 'prose', props: { body: 'y' } }] } } as BlockRow
    const tree: BlockRow[] = [
      { id: 'a', type: 'hero', props: { heading: 'A' }, slots: { default: [{ id: 'a1', type: 'prose', props: { body: 'x' } }] } },
      c,
    ]
    const out = updatePropById(tree, 'a1', 'body', 'edited')
    // the unrelated sibling C and its slot array keep their identity (no churn)
    expect(out[1]).toBe(c)
    expect(out[1]!.slots!.default).toBe(c.slots!.default)
    // the edited path IS rebuilt (new refs) and the value applied
    expect(out[0]).not.toBe(tree[0])
    expect((out[0]!.slots!.default as BlockRow[])[0]!.props.body).toBe('edited')
  })
})

describe('blankBlock', () => {
  it('seeds a block of the given type with default-valued props and a fresh id', () => {
    const b = blankBlock('hero', schemas, ids())
    expect(b).toEqual({ id: 'n0', type: 'hero', props: { heading: '', sub: '' } })
  })
})

describe('cloneBlockTree', () => {
  it('deep-clones with fresh ids at every depth and no shared references', () => {
    const src = fixture()[0]!
    const copy = cloneBlockTree(src, ids())
    expect(copy.id).toBe('n0')
    expect((copy.slots!.default as BlockRow[])[0]!.id).toBe('n1')
    expect(copy.props).not.toBe(src.props)
    expect((copy.slots!.default as BlockRow[])[0]).not.toBe((src.slots!.default as BlockRow[])[0])
  })
})

describe('findInTree', () => {
  it('locates a top-level block with its siblings/index/parent', () => {
    const f = findInTree(fixture(), 'b')!
    expect(f.block.id).toBe('b')
    expect(f.index).toBe(1)
    expect(f.siblings.length).toBe(2)
    expect(f.parentId).toBeNull()
    expect(f.slotName).toBeNull()
  })

  it('locates a nested slot block with its parent id + slot name', () => {
    const f = findInTree(fixture(), 'a1')!
    expect(f.block.id).toBe('a1')
    expect(f.index).toBe(0)
    expect(f.parentId).toBe('a')
    expect(f.slotName).toBe('default')
  })

  it('returns null for an unknown id', () => {
    expect(findInTree(fixture(), 'nope')).toBeNull()
  })
})

describe('updatePropById', () => {
  it('updates a nested block prop immutably (original untouched, unrelated subtree shared by ref)', () => {
    const tree = fixture()
    const next = updatePropById(tree, 'a1', 'body', 'y')
    expect((next[0]!.slots!.default as BlockRow[])[0]!.props.body).toBe('y')
    expect((tree[0]!.slots!.default as BlockRow[])[0]!.props.body).toBe('x') // original immutable
    expect(next[1]).toBe(tree[1]) // unrelated sibling kept by reference
  })
})

describe('removeById / removalRetarget', () => {
  it('removes a nested block, leaving its slot array empty', () => {
    const next = removeById(fixture(), 'a1')
    expect(next[0]!.slots!.default).toEqual([])
    expect(next[1]!.id).toBe('b')
  })

  it('removes a top-level block', () => {
    expect(removeById(fixture(), 'a').map((b) => b.id)).toEqual(['b'])
  })

  it('retargets selection to the previous sibling, else next, else parent', () => {
    expect(removalRetarget(fixture(), 'b')).toBe('a') // prev sibling
    expect(removalRetarget(fixture(), 'a')).toBe('b') // no prev → next sibling
    expect(removalRetarget(fixture(), 'a1')).toBe('a') // only child → parent
  })
})

describe('moveById', () => {
  it('moves a block within its container and clamps at the boundary', () => {
    expect(moveById(fixture(), 'b', -1).map((b) => b.id)).toEqual(['b', 'a'])
    expect(moveById(fixture(), 'a', -1).map((b) => b.id)).toEqual(['a', 'b']) // already first → unchanged order
  })
})

describe('duplicateById', () => {
  it('inserts a fresh-id deep copy right after the source, returns the new id', () => {
    const { tree, newId } = duplicateById(fixture(), 'a', ids())
    expect(tree.map((b) => b.id)).toEqual(['a', 'n0', 'b'])
    expect(newId).toBe('n0')
    expect((tree[1]!.slots!.default as BlockRow[])[0]!.id).toBe('n1') // child re-ided
  })
})

describe('addBlock', () => {
  it('appends a seeded block at the root', () => {
    const { tree, newId } = addBlock(fixture(), null, null, 'prose', schemas, ids())
    expect(tree.map((b) => b.id)).toEqual(['a', 'b', 'n0'])
    expect(newId).toBe('n0')
    expect(tree[2]!.props).toEqual({ body: '' })
  })

  it('appends a seeded block into a parent slot', () => {
    const { tree, newId } = addBlock(fixture(), 'a', 'default', 'prose', schemas, ids())
    const slot = tree[0]!.slots!.default as BlockRow[]
    expect(slot.map((b) => b.id)).toEqual(['a1', 'n0'])
    expect(newId).toBe('n0')
  })
})

describe('errorBearingIds', () => {
  it('includes the erroring block and all its ancestors (roll-up), not unrelated blocks', () => {
    const ids = errorBearingIds(fixture(), new Set(['a1']))
    expect(ids).toEqual(new Set(['a', 'a1']))
  })

  it('marks only the block itself when it is top-level', () => {
    expect(errorBearingIds(fixture(), new Set(['b']))).toEqual(new Set(['b']))
  })
})
