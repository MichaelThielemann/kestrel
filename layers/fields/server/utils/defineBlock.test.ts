import { describe, it, expect, beforeEach } from 'vitest'
import { defineBlock, registerBlock, clearBlocks, allBlocks, buildBlocksSchema } from './defineBlock'

beforeEach(() => clearBlocks())

describe('buildBlocksSchema', () => {
  it('empty registry → accepts [] only', () => {
    const s = buildBlocksSchema([])
    expect(s.safeParse([]).success).toBe(true)
    expect(s.safeParse([{ id: 'a', type: 'hero', props: {} }]).success).toBe(false)
  })

  it('accepts a known block with valid props and strict slots', () => {
    registerBlock(defineBlock({
      name: 'hero',
      fields: { heading: { type: 'text', required: true } },
      slots: ['default'],
    }))
    const s = buildBlocksSchema(allBlocks())
    expect(s.safeParse([{ id: 'a', type: 'hero', props: { heading: 'Hi' } }]).success).toBe(true)
  })

  it('rejects an unknown block type', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { heading: { type: 'text', required: true } } }))
    expect(buildBlocksSchema(allBlocks()).safeParse([{ id: 'a', type: 'nope', props: {} }]).success).toBe(false)
  })

  it('enforces conditional-required block props (required-when-visible), not just top-level fields', () => {
    registerBlock(defineBlock({ name: 'cta', fields: {
      showCta: { type: 'boolean' },
      ctaLabel: { type: 'text', required: true, condition: { field: 'showCta', is: true } },
    } }))
    const s = buildBlocksSchema(allBlocks())
    // condition met + empty required prop → rejected
    expect(s.safeParse([{ id: 'a', type: 'cta', props: { showCta: true } }]).success).toBe(false)
    // condition met + filled → accepted
    expect(s.safeParse([{ id: 'a', type: 'cta', props: { showCta: true, ctaLabel: 'Go' } }]).success).toBe(true)
    // condition NOT met → the empty required prop is legitimately optional
    expect(s.safeParse([{ id: 'a', type: 'cta', props: { showCta: false } }]).success).toBe(true)
  })

  it('enforces conditional-required sub-fields inside a repeater block prop', () => {
    registerBlock(defineBlock({ name: 'list', fields: {
      items: { type: 'repeater', options: { fields: {
        withLink: { type: 'boolean' },
        href: { type: 'text', required: true, condition: { field: 'withLink', is: true } },
      } } },
    } }))
    const s = buildBlocksSchema(allBlocks())
    expect(s.safeParse([{ id: 'a', type: 'list', props: { items: [{ withLink: true }] } }]).success).toBe(false)
    expect(s.safeParse([{ id: 'a', type: 'list', props: { items: [{ withLink: true, href: '/x' }] } }]).success).toBe(true)
    expect(s.safeParse([{ id: 'a', type: 'list', props: { items: [{ withLink: false }] } }]).success).toBe(true)
  })

  it('rejects invalid props (missing required) and sanitizes richtext props', () => {
    registerBlock(defineBlock({ name: 'prose', fields: { body: { type: 'richtext', required: true } } }))
    const s = buildBlocksSchema(allBlocks())
    expect(s.safeParse([{ id: 'a', type: 'prose', props: {} }]).success).toBe(false)
    const ok = s.parse([{ id: 'a', type: 'prose', props: { body: '<script>x</script><p>ok</p>' } }]) as Array<{ props: { body: string } }>
    expect(ok[0].props.body).toBe('<p>ok</p>')
  })

  it('recurses through declared slots', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { heading: { type: 'text', required: true } }, slots: ['default'] }))
    const s = buildBlocksSchema(allBlocks())
    expect(s.safeParse([
      { id: 'a', type: 'hero', props: { heading: 'H' }, slots: { default: [{ id: 'b', type: 'hero', props: { heading: 'C' } }] } },
    ]).success).toBe(true)
  })

  it('accepts a reasonably nested block tree', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { heading: { type: 'text', required: true } }, slots: ['default'] }))
    const s = buildBlocksSchema(allBlocks())
    let node: unknown = { id: 'leaf', type: 'hero', props: { heading: 'x' } }
    for (let i = 0; i < 5; i++) node = { id: `n${i}`, type: 'hero', props: { heading: 'x' }, slots: { default: [node] } }
    expect(s.safeParse([node]).success).toBe(true)
  })

  it('rejects an excessively deep block tree with a clean validation error (no RangeError/500)', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { heading: { type: 'text', required: true } }, slots: ['default'] }))
    const s = buildBlocksSchema(allBlocks())
    let node: unknown = { id: 'leaf', type: 'hero', props: { heading: 'x' } }
    for (let i = 0; i < 300; i++) node = { id: `n${i}`, type: 'hero', props: { heading: 'x' }, slots: { default: [node] } }
    const r = s.safeParse([node]) // must not throw; must fail cleanly
    expect(r.success).toBe(false)
  })
})
