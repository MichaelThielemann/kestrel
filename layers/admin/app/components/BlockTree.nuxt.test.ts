import { describe, it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { SerializedBlock } from '@kestrel/core'
import type { BlockRow, BlockTreeCtx } from '../utils/block-tree'
import BlockTree from './BlockTree.vue'

const defs = [
  { name: 'card', label: 'Card', icon: 'image', fields: { title: { type: 'text', required: true, unique: false } } },
  { name: 'note', label: 'Note', fields: { text: { type: 'text', required: false, unique: false } } },
  { name: 'section', label: 'Section', slots: ['default'], fields: { title: { type: 'text', required: true, unique: false } } },
] as unknown as SerializedBlock[]
const byName = Object.fromEntries(defs.map((d) => [d.name, d]))

function makeOps() {
  return { select: vi.fn(), add: vi.fn(), remove: vi.fn(), move: vi.fn(), duplicate: vi.fn() }
}
function ctxWith(ops: ReturnType<typeof makeOps>): BlockTreeCtx {
  return { byName, allowedTypes: defs, ops }
}

const baseProps = (over: Record<string, unknown>) => ({
  root: true,
  selectedId: null,
  errorIds: new Set<string>(),
  disabled: false,
  ...over,
})

describe('BlockTree', () => {
  it('renders the selectable page root and a node per block (with its label)', async () => {
    const ops = makeOps()
    const w = await mountSuspended(BlockTree, {
      props: baseProps({ blocks: [{ id: 'a', type: 'card', props: { title: 'A' } }] as BlockRow[], ctx: ctxWith(ops) }),
    })
    await flushPromises()
    expect(w.find('.block-tree__root').exists()).toBe(true)
    expect(w.findAll('.block-tree__node')).toHaveLength(1)
    expect(w.find('.block-tree__node-label').text()).toContain('Card')
  })

  it('highlights the page root when nothing is selected, and a node when it is selected', async () => {
    const ops = makeOps()
    const blocks = [{ id: 'a', type: 'card', props: {} }] as BlockRow[]
    const rootSel = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops), selectedId: null }) })
    expect(rootSel.find('.block-tree__root').classes()).toContain('block-tree__node-label--selected')

    const blockSel = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops), selectedId: 'a' }) })
    expect(blockSel.find('.block-tree__node-label--selected').text()).toContain('Card')
  })

  it('exposes the selected state programmatically via aria-pressed', async () => {
    const ops = makeOps()
    const blocks = [{ id: 'a', type: 'card', props: {} }] as BlockRow[]
    const rootSel = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops), selectedId: null }) })
    expect(rootSel.find('.block-tree__root').attributes('aria-pressed')).toBe('true')
    expect(rootSel.find('.block-tree__node-label').attributes('aria-pressed')).toBe('false')

    const blockSel = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops), selectedId: 'a' }) })
    expect(blockSel.find('.block-tree__root').attributes('aria-pressed')).toBe('false')
    expect(blockSel.find('.block-tree__node-label').attributes('aria-pressed')).toBe('true')
  })

  it('selecting the root or a node calls ops.select', async () => {
    const ops = makeOps()
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks: [{ id: 'a', type: 'card', props: {} }] as BlockRow[], ctx: ctxWith(ops) }) })
    await w.find('.block-tree__root').trigger('click')
    expect(ops.select).toHaveBeenCalledWith(null)
    await w.find('.block-tree__node-label').trigger('click')
    expect(ops.select).toHaveBeenCalledWith('a')
  })

  it('shows an error badge on a block in errorIds', async () => {
    const ops = makeOps()
    const w = await mountSuspended(BlockTree, {
      props: baseProps({ blocks: [{ id: 'a', type: 'card', props: {} }] as BlockRow[], ctx: ctxWith(ops), errorIds: new Set(['a']) }),
    })
    expect(w.find('.block-tree__node .block-tree__badge').exists()).toBe(true)
  })

  it('shows a stale-reference badge on a block in deadRefIds (none without it)', async () => {
    const ops = makeOps()
    const blocks = [{ id: 'a', type: 'card', props: {} }] as BlockRow[]
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops), deadRefIds: new Set(['a']) }) })
    expect(w.find('.block-tree__node .block-tree__deadbadge').exists()).toBe(true)
    const clean = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops) }) })
    expect(clean.find('.block-tree__deadbadge').exists()).toBe(false)
  })

  it('the structural controls call the matching id-addressed op (no type switch)', async () => {
    const ops = makeOps()
    const blocks = [{ id: 'a', type: 'card', props: {} }, { id: 'b', type: 'card', props: {} }] as BlockRow[]
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops) }) })
    await w.find('[aria-label="Move block 1 down"]').trigger('click')
    expect(ops.move).toHaveBeenCalledWith('a', 1)
    await w.find('[aria-label="Duplicate block 2"]').trigger('click')
    expect(ops.duplicate).toHaveBeenCalledWith('b')
    await w.find('[aria-label="Remove block 1"]').trigger('click')
    expect(ops.remove).toHaveBeenCalledWith('a')
    // the block type is fixed once created — no in-row type switcher
    expect(w.find('.block-tree__type').exists()).toBe(false)
  })

  it('keeps every row\'s action controls in the DOM as keyboard-reachable buttons (incl. nested rows)', async () => {
    const ops = makeOps()
    const blocks = [{ id: 'a', type: 'section', props: { title: 'T' }, slots: { default: [{ id: 'b', type: 'note', props: { text: 'inner' } }] } }] as BlockRow[]
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops) }) })
    await flushPromises()
    // The action bar is a hover/focus-revealed absolute overlay (opacity + pointer-events), but its four
    // controls stay real <button>s in the DOM so they remain tabbable — assert for every row, including
    // the note nested inside the section's slot.
    const actionBars = w.findAll('.block-tree__actions')
    expect(actionBars.length).toBeGreaterThanOrEqual(2) // section row + nested note row
    for (const bar of actionBars) {
      const btns = bar.findAll('.block-tree__btn')
      expect(btns).toHaveLength(4)
      for (const b of btns) {
        expect(b.element.tagName).toBe('BUTTON')
        expect(b.attributes('aria-label')).toBeTruthy()
      }
    }
  })

  it('adds a block via the type picker at the root (parentId/slotName null)', async () => {
    const ops = makeOps()
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks: [] as BlockRow[], ctx: ctxWith(ops) }) })
    await flushPromises()
    // the picker is closed until "Add block" is pressed
    expect(w.find('.block-tree__picker').exists()).toBe(false)
    await w.findAll('button').find((b) => b.text() === 'Add block')!.trigger('click')
    expect(w.find('.block-tree__picker').exists()).toBe(true)
    // the picker is a grid of one tile per allowed block type
    expect(w.findAll('.block-tree__picker-item')).toHaveLength(defs.length)
    // every tile shows an icon: `card` has its own (defineBlock icon), `note`/`section` use the fallback
    expect(w.findAll('.block-tree__picker-icon')).toHaveLength(defs.length)
    await w.find('[aria-label="Add Card"]').trigger('click')
    expect(ops.add).toHaveBeenCalledWith(null, null, 'card')
    // picking a type closes the picker again
    expect(w.find('.block-tree__picker').exists()).toBe(false)
  })

  it('opens the picker inside a centered dialog and marks the trigger active while open', async () => {
    const ops = makeOps()
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks: [] as BlockRow[], ctx: ctxWith(ops) }) })
    await flushPromises()
    const trigger = () => w.findAll('button').find((b) => b.text() === 'Add block')!
    expect(w.find('.ui-dialog__content').exists()).toBe(false)
    expect(trigger().classes()).not.toContain('block-tree__add-btn--active')
    await trigger().trigger('click')
    // the picker grid lives inside the dialog (position:fixed) content, not in the tree flow
    expect(w.find('.ui-dialog__content').exists()).toBe(true)
    expect(w.find('.ui-dialog__content .block-tree__picker').exists()).toBe(true)
    expect(trigger().classes()).toContain('block-tree__add-btn--active')
  })

  it('closing the dialog via its close button clears the picker and the active marker', async () => {
    const ops = makeOps()
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks: [] as BlockRow[], ctx: ctxWith(ops) }) })
    await flushPromises()
    const trigger = () => w.findAll('button').find((b) => b.text() === 'Add block')!
    await trigger().trigger('click')
    expect(w.find('.block-tree__picker').exists()).toBe(true)
    await w.find('[data-test="dialog-close"]').trigger('click')
    await flushPromises()
    expect(w.find('.block-tree__picker').exists()).toBe(false)
    expect(trigger().classes()).not.toContain('block-tree__add-btn--active')
  })

  it('renders a preview image above the name (and suppresses the icon) for a def with `image`', async () => {
    const ops = makeOps()
    const imgDefs = [
      { name: 'card', label: 'Card', icon: 'image', fields: {} },
      { name: 'hero', label: 'Hero', icon: 'image', image: '/block-previews/hero.png', fields: {} },
    ] as unknown as SerializedBlock[]
    const ctx: BlockTreeCtx = { byName: Object.fromEntries(imgDefs.map((d) => [d.name, d])), allowedTypes: imgDefs, ops }
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks: [] as BlockRow[], ctx }) })
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Add block')!.trigger('click')
    const imgs = w.findAll('.block-tree__picker-img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.attributes('src')).toBe('/block-previews/hero.png')
    // the image tile suppresses its icon; the icon-only tile still renders one
    expect(w.findAll('.block-tree__picker-icon')).toHaveLength(1)
  })

  it('renders a nested tree for a slot-declaring block and adds into the slot via its picker', async () => {
    const ops = makeOps()
    const blocks = [{ id: 'a', type: 'section', props: { title: 'T' }, slots: { default: [{ id: 'b', type: 'note', props: { text: 'inner' } }] } }] as BlockRow[]
    const w = await mountSuspended(BlockTree, { props: baseProps({ blocks, ctx: ctxWith(ops) }) })
    await flushPromises()
    const slot = w.find('.block-tree__slot')
    expect(slot.exists()).toBe(true)
    expect(slot.find('.block-tree__slot-label').text()).toBe('default')
    // the nested node for the slot child is present
    expect(w.findAll('.block-tree__node-label').some((l) => l.text().includes('Note'))).toBe(true)
    // adding inside the slot carries the parent id + slot name
    await slot.findAll('button').find((b) => b.text() === 'Add to default')!.trigger('click')
    await slot.find('[aria-label="Add Card"]').trigger('click')
    expect(ops.add).toHaveBeenCalledWith('a', 'default', 'card')
  })
})
