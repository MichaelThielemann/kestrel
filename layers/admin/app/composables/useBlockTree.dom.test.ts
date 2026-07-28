import { describe, it, expect } from 'vitest'
import { ref, nextTick } from 'vue'
import type { SerializedBlock } from '../../../core/server/utils/serialize-collection'
import type { BlockRow } from '../utils/block-tree'
import { useBlockTree } from './useBlockTree'

const schemas = ref({
  hero: { name: 'hero', slots: ['default'], fields: { heading: { type: 'text' } } },
  prose: { name: 'prose', fields: { body: { type: 'text' } } },
} as unknown as Record<string, SerializedBlock>)

function gen() {
  let n = 0
  return () => `n${n++}`
}

describe('useBlockTree', () => {
  it('seeds from the model and exposes the nested blocks', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'prose', props: { body: 'A' } }])
    const { blocks } = useBlockTree(model, schemas, gen())
    expect(blocks.value.map((b) => b.id)).toEqual(['a'])
  })

  it('add appends a seeded block, selects it, and emits the whole array', () => {
    const model = ref<unknown[]>([])
    const t = useBlockTree(model, schemas, gen())
    t.add(null, null, 'prose')
    expect(t.blocks.value).toEqual([{ id: 'n0', type: 'prose', props: { body: '' } }])
    expect(t.selectedId.value).toBe('n0')
    expect(model.value).toEqual(t.blocks.value)
  })

  it('setProp updates immutably and emits', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'prose', props: { body: 'A' } }])
    const t = useBlockTree(model, schemas, gen())
    t.setProp('a', 'body', 'B')
    expect((model.value[0] as BlockRow).props.body).toBe('B')
  })

  it('select sets the selected id and selectedBlock resolves it (including nested)', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'hero', props: {}, slots: { default: [{ id: 'a1', type: 'prose', props: { body: 'x' } }] } }])
    const t = useBlockTree(model, schemas, gen())
    expect(t.selectedBlock.value).toBeNull() // root selected by default
    t.select('a1')
    expect(t.selectedBlock.value?.id).toBe('a1')
  })

  it('remove retargets the selection and emits', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'prose', props: {} }, { id: 'b', type: 'prose', props: {} }])
    const t = useBlockTree(model, schemas, gen())
    t.select('b')
    t.remove('b')
    expect(t.blocks.value.map((b) => b.id)).toEqual(['a'])
    expect(t.selectedId.value).toBe('a') // retargeted to previous sibling
  })

  it('duplicate selects the new copy with fresh ids', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'hero', props: {}, slots: { default: [{ id: 'a1', type: 'prose', props: {} }] } }])
    const t = useBlockTree(model, schemas, gen())
    t.duplicate('a')
    expect(t.blocks.value.map((b) => b.id)).toEqual(['a', 'n0'])
    expect(t.selectedId.value).toBe('n0')
    expect((t.blocks.value[1]!.slots!.default as BlockRow[])[0]!.id).toBe('n1')
  })

  it('move reorders within the container', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'prose', props: {} }, { id: 'b', type: 'prose', props: {} }])
    const t = useBlockTree(model, schemas, gen())
    t.move('b', -1)
    expect(t.blocks.value.map((b) => b.id)).toEqual(['b', 'a'])
  })

  it('retargets the selection when an ANCESTOR of the selected block is removed', () => {
    const model = ref<unknown[]>([
      { id: 'a', type: 'hero', props: {}, slots: { default: [{ id: 'a1', type: 'prose', props: {} }] } },
      { id: 'b', type: 'prose', props: {} },
    ])
    const t = useBlockTree(model, schemas, gen())
    t.select('a1') // a nested block inside a's slot
    t.remove('a') // removes the ancestor + its whole subtree (incl. the selected a1)
    expect(t.blocks.value.map((b) => b.id)).toEqual(['b'])
    expect(t.selectedId.value).toBe('b') // healed to the removed block's sibling
  })

  it('add into a slot appends to the slot array and selects the new child', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'hero', props: {}, slots: { default: [] } }])
    const t = useBlockTree(model, schemas, gen())
    t.add('a', 'default', 'prose')
    expect((t.blocks.value[0]!.slots!.default as BlockRow[]).map((b) => b.id)).toEqual(['n0'])
    expect(t.selectedId.value).toBe('n0')
  })

  it('routes an emit through an injected setContent, tagged with a distinct coalesce key per op', () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'prose', props: { body: 'A' } }, { id: 'b', type: 'prose', props: {} }])
    const calls: string[] = []
    const setContent = (v: unknown[], coalesceAs: string) => { model.value = v; calls.push(coalesceAs) }
    const t = useBlockTree(model, schemas, gen(), setContent)
    t.setProp('a', 'body', 'B')
    t.move('b', -1)
    t.duplicate('a')
    t.remove('b')
    t.add(null, null, 'prose')
    expect(calls).toEqual([
      'content:prop:a:body',
      'content:move:b',
      'content:duplicate:a',
      'content:remove:b',
      'content:add:null:null:prose',
    ])
  })

  it('echo-guards its own emit but reseeds on an external model change, clearing a stale selection', async () => {
    const model = ref<unknown[]>([{ id: 'a', type: 'prose', props: { body: 'A' } }])
    const t = useBlockTree(model, schemas, gen())
    t.select('a')
    t.setProp('a', 'body', 'B')
    await nextTick()
    expect(t.blocks.value[0]!.props.body).toBe('B') // own emit did not reseed/revert
    expect(t.selectedId.value).toBe('a')
    model.value = [{ id: 'c', type: 'prose', props: { body: 'C' } }] // external replacement
    await nextTick()
    expect(t.blocks.value.map((b) => b.id)).toEqual(['c'])
    expect(t.selectedId.value).toBeNull() // selected 'a' is gone → cleared
  })

  it('tracks the model through an external undo → redo (no stale-token desync)', async () => {
    // useEditForm's undo/redo restore `values.content`, which feeds this model. After add→undo→redo the
    // tree must follow the redone content — not stay stuck at the pre-add state (which would then get
    // re-emitted by the next structural op, silently reverting the redo).
    const model = ref<unknown[]>([])
    const t = useBlockTree(model, schemas, gen())
    t.add(null, null, 'prose') // C1: one block
    await nextTick()
    const c1 = JSON.parse(JSON.stringify(model.value)) as BlockRow[]
    expect(c1).toHaveLength(1)

    model.value = [] // undo → back to the empty pre-add content (C0)
    await nextTick()
    expect(t.blocks.value).toHaveLength(0)

    model.value = JSON.parse(JSON.stringify(c1)) // redo → C1 again (fresh array, equal content)
    await nextTick()
    expect(t.blocks.value).toEqual(c1) // must reseed to the redone content, not the stale C0
  })
})
