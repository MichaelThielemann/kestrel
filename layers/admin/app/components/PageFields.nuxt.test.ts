import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import PageFields from './PageFields.vue'

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
