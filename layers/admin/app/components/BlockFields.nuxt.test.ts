import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { SerializedBlock } from '@michaelthielemann/kestrel-core'
import type { BlockRow } from '../utils/block-tree'
import BlockFields from './BlockFields.vue'

const cardDef = {
  name: 'card', label: 'Card',
  fields: {
    title: { type: 'text', required: true, unique: false },
    count: { type: 'number', required: false, unique: false },
  },
} as unknown as SerializedBlock

const block: BlockRow = { id: 'a', type: 'card', props: { title: 'Hello', count: 1 } }

describe('BlockFields', () => {
  it('renders the selected block label + its fields with current values', async () => {
    const w = await mountSuspended(BlockFields, { props: { block, def: cardDef, locale: 'en' } })
    await flushPromises()
    expect(w.find('.block-fields__title').text()).toBe('Card')
    expect((w.find('.block-fields input').element as HTMLInputElement).value).toBe('Hello')
  })

  it('emits (key, value) on a field edit', async () => {
    const w = await mountSuspended(BlockFields, { props: { block, def: cardDef, locale: 'en' } })
    await flushPromises()
    await w.find('.block-fields input').setValue('World')
    const emitted = w.emitted('update')
    expect(emitted).toBeTruthy()
    expect(emitted!.at(-1)).toEqual(['title', 'World'])
  })

  it('shows the per-field error from the id-keyed error entry', async () => {
    const w = await mountSuspended(BlockFields, { props: { block, def: cardDef, locale: 'en', errors: { title: 'Required' } } })
    await flushPromises()
    const err = w.find('.ui-field__error[role="alert"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toBe('Required')
  })

  it('hides a field whose condition is unmet against sibling props, and shows it when met', async () => {
    const def = {
      name: 'media', label: 'Media',
      fields: {
        format: { type: 'text', required: false, unique: false },
        alt: { type: 'text', required: false, unique: false, condition: { field: 'format', is: 'image' } },
      },
    } as unknown as SerializedBlock

    const hidden = await mountSuspended(BlockFields, { props: { block: { id: 'a', type: 'media', props: { format: 'embed', alt: '' } }, def, locale: 'en' } })
    await flushPromises()
    expect(hidden.findAll('.block-fields input').length).toBe(1) // only `format`

    const shown = await mountSuspended(BlockFields, { props: { block: { id: 'a', type: 'media', props: { format: 'image', alt: '' } }, def, locale: 'en' } })
    await flushPromises()
    expect(shown.findAll('.block-fields input').length).toBe(2) // `format` + `alt`
  })

  it('shows a stale-reference note on a field in deadFields (none without it)', async () => {
    const w = await mountSuspended(BlockFields, { props: { block, def: cardDef, locale: 'en', deadFields: new Set(['title']) } })
    await flushPromises()
    expect(w.find('.field-dead-ref').exists()).toBe(true)

    const clean = await mountSuspended(BlockFields, { props: { block, def: cardDef, locale: 'en' } })
    await flushPromises()
    expect(clean.find('.field-dead-ref').exists()).toBe(false)
  })

  it('shows the no-fields message for a block type with no editable fields', async () => {
    const layoutDef = { name: 'spacer', label: 'Spacer', fields: {} } as unknown as SerializedBlock
    const w = await mountSuspended(BlockFields, { props: { block: { id: 's', type: 'spacer', props: {} }, def: layoutDef, locale: 'en' } })
    await flushPromises()
    expect(w.find('.block-fields__empty').text()).toBe('This block has no editable fields.')
  })
})
