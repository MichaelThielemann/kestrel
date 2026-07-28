import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from '#imports'
import { flushPromises } from '@vue/test-utils'
import { createError, readBody } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import CollectionEditor from './CollectionEditor.vue'
import { useToast } from '../../../ui/app/composables/useToast'

const schema = {
  name: 'things', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false },
  fields: {
    title: { type: 'text', required: true, translatable: false, unique: false },
    subtitle: { type: 'text', required: false, translatable: false, unique: false },
  },
}
const pagesSchema = {
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, seo: true, status: false,
  blocks: { enabled: true, allowed: ['hero', 'prose'] },
  fields: { title: { type: 'text', required: true, translatable: false, unique: false } },
}
const articlesSchema = {
  name: 'articles', mode: 'multi', translatable: true, pageLike: false, seo: false, status: false,
  blocks: { enabled: false },
  fields: { title: { type: 'text', required: true, translatable: true, unique: false } },
}
// Blocks-enabled AND translatable: exercises the LocaleBar living inside the page-fields pane.
const localpagesSchema = {
  name: 'localpages', mode: 'multi', translatable: true, pageLike: true, seo: false, status: false,
  blocks: { enabled: true, allowed: ['hero', 'prose'] },
  fields: { title: { type: 'text', required: true, translatable: true, unique: false } },
}
// An explicit editor type with no registered body → the visible fallback panel.
const widgetsSchema = {
  name: 'widgets', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, editor: 'node-graph',
  fields: { title: { type: 'text', required: true, translatable: false, unique: false } },
}
registerEndpoint('/api/collections', () => ({ data: [schema, pagesSchema, articlesSchema, localpagesSchema, widgetsSchema] }))
registerEndpoint('/api/blocks', () => ({
  data: [
    { name: 'hero', label: 'Hero', fields: { heading: { type: 'text', required: true }, image: { type: 'media', options: { accept: 'image' } } } },
    { name: 'prose', label: 'Prose', fields: { body: { type: 'richtext', required: true } } },
  ],
}))
registerEndpoint('/api/media/resolve', () => ({ data: [] }))
registerEndpoint('/api/pages', () => ({ data: [], total: 0, page: 1, perPage: 25 }))

// An existing EN article (id 1) with a DE sibling (id 2) — drives the LocaleBar copy control.
registerEndpoint('/api/articles/1', () => ({ id: 1, title: 'English title', locale: 'en', translationGroup: 'grp1' }))
registerEndpoint('/api/articles/1/translations', () => ({ en: 1, de: 2 }))
registerEndpoint('/api/articles/1/dead-refs', () => [])
registerEndpoint('/api/articles/2', () => ({ id: 2, title: 'Deutscher Titel', locale: 'de', translationGroup: 'grp1' }))

beforeEach(() => {
  useState('kestrel-collections').value = null
  useState('kestrel-blocks').value = null
})

const settle = async () => {
  await new Promise((r) => setTimeout(r, 20))
  await flushPromises()
}

let posted: Record<string, unknown> | null = null
registerEndpoint('/api/things', async (event) => {
  if (event.method === 'POST') {
    posted = await readBody(event)
    if (posted!.title === 'dup') throw createError({ statusCode: 409, statusMessage: 'Conflict: duplicate path' })
    return { id: 1, ...posted }
  }
  return { data: [], total: 0, page: 1, perPage: 25 }
})

describe('CollectionEditor', () => {
  it('renders one field per schema entry', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    expect(w.findAll('.ui-field__label').map((l) => l.text())).toEqual(['Title*', 'Subtitle'])
    expect(w.findAll('input').length).toBe(2)
  })

  it('disables native constraint validation on the form (Zod owns validation)', async () => {
    // Without novalidate the browser validates natively BEFORE the submit event: a native `required`
    // on a proxy input (e.g. the multi-relation combobox search box, empty although records are
    // selected) blocks the save with a browser bubble and onSave never runs.
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    expect(w.find('form').attributes('novalidate')).toBeDefined()
  })

  it('surfaces a per-field validation error', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    const title = w.find('input')
    await title.setValue('hi')
    await title.setValue('')
    await flushPromises()
    const err = w.find('.ui-field__error[role="alert"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toBe('This field is required.')
  })

  it('saves and emits "saved" with the server row', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    await w.findAll('input')[0]!.setValue('My Title')
    await w.find('form').trigger('submit')
    await settle()
    expect(posted).toMatchObject({ title: 'My Title' })
    const saved = w.emitted('saved')
    expect(saved).toBeTruthy()
    expect(saved![0]![0]).toMatchObject({ id: 1, title: 'My Title' })
  })

  it('shows a form-level banner on a 409 conflict', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    await w.findAll('input')[0]!.setValue('dup')
    await w.find('form').trigger('submit')
    await settle()
    const banner = w.find('.editor__error[role="alert"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('Conflict')
    expect(w.emitted('saved')).toBeFalsy()
  })

  it('renders the 3-pane block editor (tree · preview · fields) for a blocks-enabled collection', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'pages', id: 'new' } })
    await flushPromises()
    expect(w.find('.editor3').exists()).toBe(true)
    expect(w.find('.block-tree').exists()).toBe(true)
    expect(w.find('.block-preview').exists()).toBe(true)
    // default selection is the page root → the fields pane shows the collection (page) fields
    expect(w.find('.editor3__fields .ui-field__label').text()).toContain('Title')
  })

  it('renders no preview pane for a flat collection', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    expect(w.find('.block-preview').exists()).toBe(false)
  })

  it('renders the fallback panel for a collection whose editor type has no registered body', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'widgets', id: 'new' } })
    await flushPromises()
    expect(w.find('.editor-unsupported').exists()).toBe(true)
    expect(w.find('.editor-unsupported').text()).toContain('node-graph')
    // Neither built-in body rendered.
    expect(w.find('.editor__flat').exists()).toBe(false)
    expect(w.find('.editor3').exists()).toBe(false)
  })

  it('shows the content LocaleBar as a labelled page option, alongside the fields (flat collection)', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'articles', id: 'new' } })
    await flushPromises()
    // The LocaleBar is a page-level option living with the page fields, not a separate top bar.
    expect(w.find('.editor__flat .locale-bar').exists()).toBe(true)
    expect(w.find('.locale-bar__item--active').text()).toContain('EN')
    expect(w.find('.locale-bar__btn--add').exists()).toBe(true)
    // It carries a field-style "Locale" label like the other page fields.
    expect(w.findAll('.editor__flat .ui-field__label').map((l) => l.text())).toContain('Locale')
  })

  it('shows the LocaleBar, labelled, inside the page-fields pane of the 3-pane editor', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'localpages', id: 'new' } })
    await flushPromises()
    // Default selection is the page root → page fields + the page-level LocaleBar share the pane.
    expect(w.find('.editor3__fields .locale-bar').exists()).toBe(true)
    const labels = w.findAll('.editor3__fields .ui-field__label').map((l) => l.text())
    expect(labels).toContain('Locale')
    expect(labels.some((l) => l.includes('Title'))).toBe(true)
  })

  it('copies a sibling locale into the form when the LocaleBar copy button is clicked', async () => {
    // The copy button bubbles `copyFrom` from LocaleBar → PageFieldsPane → CollectionEditor; a kebab-case
    // handler key in the `v-on` object would never reach onCopyFrom (and Vue would warn about a stray
    // fallthrough listener). Assert the round-trip actually mutates the form.
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'articles', id: '1' } })
    await settle()
    expect((w.find('.editor__flat input').element as HTMLInputElement).value).toBe('English title')
    const copyBtn = w.find('.locale-bar__btn--copy')
    expect(copyBtn.exists()).toBe(true) // a DE sibling exists → copy control is shown
    await copyBtn.trigger('click')
    await settle()
    expect((w.find('.editor__flat input').element as HTMLInputElement).value).toBe('Deutscher Titel')
  })

  it('renders an editable slug/path field for a pageLike collection, in the page-fields pane', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'pages', id: 'new' } })
    await flushPromises()
    const labels = w.findAll('.editor3__fields .ui-field__label').map((l) => l.text())
    expect(labels).toContain('Slug')
    // bound to the page `path` — typing updates it via setField
    const slug = w.find('.page-settings__slug input')
    expect(slug.exists()).toBe(true)
  })

  it('renders the SEO section (with Google preview) for a seo-enabled collection', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'pages', id: 'new' } })
    await flushPromises()
    expect(w.find('.editor3__fields .seo-fields').exists()).toBe(true)
    expect(w.find('.editor3__fields .seo-preview').exists()).toBe(true)
  })

  it('renders no SEO section for a collection without seo', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    expect(w.find('.seo-fields').exists()).toBe(false)
  })

  it('renders no slug field for a non-pageLike collection', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    expect(w.find('.page-settings__slug').exists()).toBe(false)
    expect(w.findAll('.ui-field__label').map((l) => l.text())).not.toContain('Slug')
  })

  // Undo/redo buttons live in the page action toolbar (record + singleton headers); CollectionEditor
  // exposes the history API they drive. Assert that contract here (the toolbar rendering is covered by
  // the page components).
  it('exposes undo/redo state, both inactive until an edit', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'pages', id: 'new' } })
    await flushPromises()
    expect((w.vm as unknown as { canUndo: boolean }).canUndo).toBe(false)
    expect((w.vm as unknown as { canRedo: boolean }).canRedo).toBe(false)
  })

  it('enables undo after an edit and reverts it via the exposed undo()', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'pages', id: 'new' } })
    await flushPromises()
    const title = w.find('.editor3__fields input')
    await title.setValue('Hello')
    await flushPromises()
    const vm = w.vm as unknown as { canUndo: boolean; undo: () => void }
    expect(vm.canUndo).toBe(true)
    vm.undo()
    await flushPromises()
    expect((w.find('.editor3__fields input').element as HTMLInputElement).value).toBe('')
  })

  it('hides the LocaleBar for a non-translatable collection', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    expect(w.find('.locale-bar').exists()).toBe(false)
  })

  it('renders no inline action row when actions is disabled (record editor drives save from its header)', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new', actions: false } })
    await flushPromises()
    expect(w.find('.editor__actions').exists()).toBe(false)
    // Submit still works via the form (the header Save button calls the exposed save()).
    await w.findAll('input')[0]!.setValue('Via Header')
    await w.find('form').trigger('submit')
    await settle()
    expect(posted).toMatchObject({ title: 'Via Header' })
    expect(w.emitted('saved')).toBeTruthy()
  })

  it('keeps inline Save/Cancel actions by default (singleton usage), each with an icon', async () => {
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    const actions = w.find('.editor__actions')
    expect(actions.exists()).toBe(true)
    const buttons = actions.findAll('.ui-button')
    expect(buttons.map((b) => b.text())).toEqual(['Save', 'Cancel'])
    for (const b of buttons) expect(b.find('.ui-icon').exists()).toBe(true)
  })

  it('on a failed save (empty required field) shows the banner and fires an error toast', async () => {
    const toast = useToast()
    toast.items.splice(0, toast.items.length)
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'things', id: 'new' } })
    await flushPromises()
    await w.find('form').trigger('submit') // title left empty
    await settle()
    const banner = w.find('.editor__error[role="alert"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('highlighted page fields')
    expect(toast.items.some((t) => t.type === 'error')).toBe(true)
    expect(w.emitted('saved')).toBeFalsy()
  })

  it('on a failed save with a block selected, reveals the page fields again (deselects) plus banner + toast', async () => {
    const toast = useToast()
    toast.items.splice(0, toast.items.length)
    const w = await mountSuspended(CollectionEditor, { props: { collection: 'pages', id: 'new' } })
    await flushPromises()
    // Add a hero block — adding auto-selects it, so the page-fields pane unmounts (BlockFields shows).
    await w.find('.block-tree__add-btn').trigger('click')
    await flushPromises()
    const heroItem = w.findAll('.block-tree__picker-item').find((b) => b.text().includes('Hero'))
    expect(heroItem).toBeTruthy()
    await heroItem!.trigger('click')
    await flushPromises()
    // a block is selected → the SEO/page fields are not in the fields pane
    expect(w.find('.editor3__fields .seo-fields').exists()).toBe(false)
    // submit with the page title still empty → blocked client-side
    await w.find('form').trigger('submit')
    await settle()
    // the block is deselected so the page fields (with the title error) are visible again, plus banner + toast
    expect(w.find('.editor3__fields .seo-fields').exists()).toBe(true)
    expect(w.find('.editor__error[role="alert"]').exists()).toBe(true)
    expect(toast.items.some((t) => t.type === 'error')).toBe(true)
  })
})
