import { describe, it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { FieldDef } from '@michaelthielemann/kestrel-core'
import PageFields from './PageFields.vue'

// The offerable set is a build-time constant; drive it from the test so the ≤1 case is reachable.
const layoutsMock = vi.hoisted(() => ({ names: ['default'] as string[] }))
mockNuxtImport('useOfferableLayouts', () => () => layoutsMock.names)

const fields = {
  format: { type: 'text' },
  alt: { type: 'text', condition: { field: 'format', is: 'image' } },
} as unknown as Record<string, FieldDef>

describe('PageFields', () => {
  it('hides a collection field whose condition is unmet against the values, shows it when met', async () => {
    const hidden = await mountSuspended(PageFields, {
      props: { fields, values: { format: 'embed', alt: '' }, errors: {}, locale: 'en' },
    })
    await flushPromises()
    expect(hidden.findAll('input').length).toBe(1) // only `format`

    const shown = await mountSuspended(PageFields, {
      props: { fields, values: { format: 'image', alt: '' }, errors: {}, locale: 'en' },
    })
    await flushPromises()
    expect(shown.findAll('input').length).toBe(2) // `format` + `alt`
  })

  it('lays out collection fields via the provided layout, with status leading and the page slug trailing', async () => {
    const twoText = { a: { type: 'text' }, b: { type: 'text' } } as unknown as Record<string, FieldDef>
    const w = await mountSuspended(PageFields, {
      props: {
        fields: twoText,
        fieldLayout: [{ kind: 'row', fields: ['a', 'b'], tracks: [2, 1] }],
        values: { status: 'draft', path: '' }, errors: {}, locale: 'en',
        status: true, pageLike: true,
      },
    })
    await flushPromises()
    // The two collection fields share one two-column row…
    const rows = w.findAll('.ui-field-row')
    expect(rows.length).toBe(1)
    expect(rows[0]!.attributes('style')).toContain('--ui-field-cols: 2fr 1fr')
    expect(rows[0]!.findAll('.ui-field-cell').length).toBe(2)
    // …bracketed by the system fields (status select above, page slug input below).
    expect(w.find('.page-settings__status').exists()).toBe(true)
    expect(w.find('.page-settings__slug').exists()).toBe(true)
  })

  it('previews the auto-generated slug from the title as the slug placeholder while blank', async () => {
    const w = await mountSuspended(PageFields, {
      props: {
        fields: { title: { type: 'text' } } as unknown as Record<string, FieldDef>,
        values: { title: 'Über uns', path: '' }, errors: {}, locale: 'en', pageLike: true,
      },
    })
    await flushPromises()
    const slug = w.findAll('input').at(-1)! // the page slug input is the last field
    expect(slug.attributes('placeholder')).toBe('/uber-uns')
  })

  it('previews the slug from the same field the server picks when there is no `title` text field', async () => {
    // pageLike collection with {name: text, description: richtext} — the server's slugSourceKey (and
    // recordTitle) fall back to the first text field, `name`, not the literal `values.title`.
    const w = await mountSuspended(PageFields, {
      props: {
        fields: { name: { type: 'text' }, description: { type: 'richtext' } } as unknown as Record<string, FieldDef>,
        values: { name: 'Acme Widget', path: '' }, errors: {}, locale: 'en', pageLike: true,
      },
    })
    await flushPromises()
    const slug = w.findAll('input').at(-1)!
    expect(slug.attributes('placeholder')).toBe('/acme-widget')
  })
})

describe('PageFields — the page layout select', () => {
  const base = { fields: {} as Record<string, FieldDef>, errors: {}, locale: 'en' }
  const find = (w: Awaited<ReturnType<typeof mountSuspended>>) =>
    w.findAll('.page-settings__layout')

  it('offers the discovered layouts, with the fallback as the empty-valued first entry', async () => {
    layoutsMock.names = ['alt', 'default']
    const w = await mountSuspended(PageFields, { props: { ...base, values: { layout: null }, pageLike: true } })
    await flushPromises()
    expect(find(w).length).toBe(1)
    const opts = w.find('.page-settings__layout').findAll('option').map((o) => o.attributes('value'))
    expect(opts).toEqual(['', 'alt'])
  })

  it('emits the chosen layout, and an empty string for the fallback', async () => {
    layoutsMock.names = ['alt', 'default']
    const w = await mountSuspended(PageFields, { props: { ...base, values: { layout: null }, pageLike: true } })
    await flushPromises()
    const select = w.find('.page-settings__layout select')
    await select.setValue('alt')
    expect(w.emitted('update')).toContainEqual(['layout', 'alt'])
    await select.setValue('')
    expect(w.emitted('update')).toContainEqual(['layout', ''])
  })

  it('stays hidden when the project ships a single layout — there is nothing to choose', async () => {
    layoutsMock.names = ['default']
    const w = await mountSuspended(PageFields, { props: { ...base, values: {}, pageLike: true } })
    await flushPromises()
    expect(find(w).length).toBe(0)
  })

  it('stays hidden for a collection that is not pageLike', async () => {
    layoutsMock.names = ['alt', 'default']
    const w = await mountSuspended(PageFields, { props: { ...base, values: {} } })
    await flushPromises()
    expect(find(w).length).toBe(0)
  })
})
