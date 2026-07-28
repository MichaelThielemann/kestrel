import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import BlockRenderer from './BlockRenderer.vue'
import { blockEditKey } from '../utils/block-edit-context'

const BlocksHero = { name: 'BlocksHero', props: ['heading', 'media'], template: '<section class="hero">{{ heading }}<slot /></section>' }
const BlocksProse = { name: 'BlocksProse', props: ['body'], template: '<div class="prose" v-html="body" />' }

const mountWith = (blocks: unknown[]) =>
  mount(BlockRenderer, { props: { blocks }, global: { components: { BlocksHero, BlocksProse } } })

const mountWithEdit = (blocks: unknown[], edit: { selectedId: ReturnType<typeof ref<string | null>>; select: (id: string) => void }) =>
  mount(BlockRenderer, {
    props: { blocks },
    global: { components: { BlocksHero, BlocksProse }, provide: { [blockEditKey as symbol]: edit } },
  })

describe('BlockRenderer', () => {
  it('renders each block via its conventional Blocks<Type> component', () => {
    const w = mountWith([
      { id: 'a', type: 'hero', props: { heading: 'Hi', $media: { image: { src: '/x.webp' } } } },
      { id: 'b', type: 'prose', props: { body: '<p>Body</p>' } },
    ])
    expect(w.get('.hero').text()).toBe('Hi')
    expect(w.get('.prose').html()).toContain('<p>Body</p>')
  })

  it('passes block.props.$media as the media prop (and not as a field)', () => {
    const w = mountWith([{ id: 'a', type: 'hero', props: { heading: 'H', $media: { image: { src: '/y.webp' } } } }])
    const hero = w.getComponent(BlocksHero)
    expect(hero.props('media')).toEqual({ image: { src: '/y.webp' } })
    expect((hero.props() as Record<string, unknown>).$media).toBeUndefined()
  })

  it('skips unknown block types without throwing', () => {
    const w = mountWith([{ id: 'z', type: 'mystery', props: {} }])
    expect(w.findAll('section, div').length).toBe(0)
  })

  // An unknown block type is a content condition, not a programming error: the renderer already reports it
  // with its own message. Vue's resolver warning would add a second, misleading one ("exclude it from
  // component resolution via compilerOptions.isCustomElement" is no advice for a CMS block type).
  it('skips unknown block types without a component-resolution warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountWith([{ id: 'z', type: 'mystery', props: {} }])
    // Named, not "no warning at all": the renderer's own dev message about the missing display component
    // is the wanted diagnostic, so only Vue's resolver warning may be absent.
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/Failed to resolve component/)
    warn.mockRestore()
  })

  it('renders nested slot blocks into the parent display-component slot', () => {
    const w = mountWith([
      {
        id: 'a',
        type: 'hero',
        props: { heading: 'Parent' },
        slots: { default: [{ id: 'b', type: 'prose', props: { body: '<p>Nested</p>' } }] },
      },
    ])
    const hero = w.get('.hero')
    expect(hero.text()).toContain('Parent')
    expect(hero.get('.prose').html()).toContain('<p>Nested</p>')
  })

  it('splits $media for nested slot blocks the same as top-level ones', () => {
    const w = mountWith([
      {
        id: 'a',
        type: 'hero',
        props: { heading: 'Parent' },
        slots: { default: [{ id: 'b', type: 'hero', props: { heading: 'Child', $media: { image: { src: '/n.webp' } } } }] },
      },
    ])
    const child = w.findAllComponents(BlocksHero)[1]
    expect(child.props('media')).toEqual({ image: { src: '/n.webp' } })
    expect((child.props() as Record<string, unknown>).$media).toBeUndefined()
  })

  // Edit/preview path: with the block-edit context provided, each block is wrapped in a selectable
  // marker. The marker is `display: contents` (no box), but it is still a real DOM element carrying the
  // id + click handler, so structure and selection must be unchanged by that CSS.
  it('wraps each block in a data-carrying marker when the edit context is present', () => {
    const w = mountWithEdit(
      [
        { id: 'a', type: 'hero', props: { heading: 'Hi' } },
        { id: 'b', type: 'prose', props: { body: '<p>Body</p>' } },
      ],
      { selectedId: ref<string | null>(null), select: () => {} },
    )
    const markerA = w.get('.block-edit-marker[data-block-id="a"]')
    expect(markerA.find('.hero').exists()).toBe(true)
    expect(w.get('.block-edit-marker[data-block-id="b"]').find('.prose').exists()).toBe(true)
  })

  it('reflects the selected block via the marker--selected class', () => {
    const w = mountWithEdit(
      [{ id: 'a', type: 'hero', props: { heading: 'Hi' } }],
      { selectedId: ref<string | null>('a'), select: () => {} },
    )
    expect(w.get('[data-block-id="a"]').classes()).toContain('block-edit-marker--selected')
  })

  it('a nested marker click selects the innermost block, not its ancestor (.stop)', async () => {
    const select = vi.fn()
    const w = mountWithEdit(
      [
        {
          id: 'a',
          type: 'hero',
          props: { heading: 'Parent' },
          slots: { default: [{ id: 'b', type: 'prose', props: { body: '<p>Nested</p>' } }] },
        },
      ],
      { selectedId: ref<string | null>(null), select },
    )
    await w.get('.block-edit-marker[data-block-id="b"]').trigger('click')
    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith('b')
  })
})
