import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { getQuery, readBody, createError } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import CollectionList from './CollectionList.vue'

const thingsSchema = {
  name: 'things', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Thing', plural: 'Things' },
  fields: {
    title: { type: 'text', required: true, unique: false },
    body: { type: 'richtext', required: false, unique: false },
  },
}

let lastQuery: Record<string, unknown> = {}
let thingsFetches = 0
registerEndpoint('/api/things/readMany', (event) => {
  lastQuery = getQuery(event)
  thingsFetches++
  return {
    data: [
      { id: 1, title: 'Alpha', body: '<p>a</p>' },
      { id: 2, title: 'Beta', body: '<p>b</p>' },
    ],
    total: 100,
    page: Number(lastQuery.page ?? 1),
    perPage: 25,
  }
})

// The write pipelines the row/bulk actions call, plus the referrer aggregate.
let thingsBulk: Record<string, unknown> | null = null
let bulkDelayMs = 0
function thingsBatchHandler(op: 'deleteMany' | 'duplicate') {
  return async (event: Parameters<typeof readBody>[0]) => {
    thingsBulk = await readBody(event)
    if (bulkDelayMs) await new Promise((r) => setTimeout(r, bulkDelayMs))
    if (op === 'duplicate') return (thingsBulk!.ids as number[]).map((n) => ({ id: n + 100 }))
    return { count: (thingsBulk!.ids as number[]).length, ids: thingsBulk!.ids }
  }
}
registerEndpoint('/api/things/deleteMany', { method: 'POST', handler: thingsBatchHandler('deleteMany') })
registerEndpoint('/api/things/duplicate', { method: 'POST', handler: thingsBatchHandler('duplicate') })
let referrersQuery: Record<string, unknown> = {}
let failReferrers = false
registerEndpoint('/api/things/referrers', (event) => {
  referrersQuery = getQuery(event)
  if (failReferrers) throw createError({ statusCode: 500, statusMessage: 'ref boom' })
  return { counts: { '1': 2 } }
})

// A status-bearing collection to prove the bulk bar's Publish/Unpublish are schema-gated.
let statusBulk: Record<string, unknown> | null = null
registerEndpoint('/api/statusy/readMany', () => ({
  data: [{ id: 1, title: 'One', status: 'draft' }, { id: 2, title: 'Two', status: 'published' }],
  total: 2, page: 1, perPage: 25,
}))
registerEndpoint('/api/statusy/updateMany', { method: 'POST', handler: async (event) => {
  statusBulk = await readBody(event)
  return { count: (statusBulk!.ids as number[]).length, ids: statusBulk!.ids }
} })
const statusSchema = {
  name: 'statusy', mode: 'multi', translatable: false, pageLike: false, seo: false, status: true,
  blocks: { enabled: false }, label: { singular: 'S', plural: 'Ss' },
  fields: { title: { type: 'text', required: true, unique: false } },
}

// A collection whose schema carries a consumer-registered custom pipeline action — proves the bulk bar
// and the row-actions cell render it generically from the wire, with no dedicated UI code.
let customBulk: Record<string, unknown> | null = null
registerEndpoint('/api/customy/readMany', () => ({
  data: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }], total: 2, page: 1, perPage: 25,
}))
registerEndpoint('/api/customy/archive', { method: 'POST', handler: async (event) => {
  customBulk = await readBody(event)
  return { ok: true }
} })
const customSchema = {
  name: 'customy', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Item', plural: 'Items' },
  fields: { title: { type: 'text', required: true, unique: false } },
  actions: [{ name: 'archive', route: { url: '/api/customy/archive', method: 'POST' }, kind: 'bulk', label: 'Archive', confirm: true }],
}

let relQuery: Record<string, unknown> = {}
registerEndpoint('/api/rel/readMany', (event) => {
  relQuery = getQuery(event)
  return { data: [{ id: 1, title: 'A', authorId: 7 }], total: 1, page: 1, perPage: 25 }
})
const relSchema = {
  name: 'rel', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Rel', plural: 'Rels' },
  fields: {
    title: { type: 'text', required: false, unique: false },
    author: { type: 'relation', required: false, unique: false, single: true, relation: { collection: 'users', many: false } },
  },
}

registerEndpoint('/api/cols/readMany', () => ({ data: [{ id: 1, title: 'X' }], total: 1, page: 1, perPage: 25 }))
const colsSchema = {
  name: 'cols', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Col', plural: 'Cols' },
  fields: { title: { type: 'text', required: false, unique: false } },
}

registerEndpoint('/api/transl/readMany', () => ({
  data: [
    { id: 1, title: 'Both', translationGroup: 'g1', $translations: { en: 1, de: 2 } },
    { id: 3, title: 'EN only', translationGroup: 'g3', $translations: { en: 3, de: null } },
  ],
  total: 2,
  page: 1,
  perPage: 25,
}))
const translSchema = {
  name: 'transl', mode: 'multi', translatable: true, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Transl', plural: 'Transls' },
  fields: { title: { type: 'text', required: true, unique: false } },
}

registerEndpoint('/api/deadlist/readMany', () => ({
  data: [
    { id: 1, title: 'Broken', $hasDeadRefs: true },
    { id: 2, title: 'Fine', $hasDeadRefs: false },
  ],
  total: 2,
  page: 1,
  perPage: 25,
}))
const deadSchema = {
  name: 'deadlist', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Item', plural: 'Items' },
  fields: {
    title: { type: 'text', required: true, unique: false },
    author: { type: 'relation', required: false, unique: false, single: true, relation: { collection: 'users', many: false } },
  },
}

// A collection spanning the typed value controls: boolean → Yes/No select, single choice → enum select,
// multi choice (stringSet) → value select, many media (idSet) → number input.
let typedQuery: Record<string, unknown> = {}
registerEndpoint('/api/typed/readMany', (event) => {
  typedQuery = getQuery(event)
  return { data: [], total: 0, page: 1, perPage: 25 }
})
const typedSchema = {
  name: 'typed', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Typed', plural: 'Typed' },
  fields: {
    active: { type: 'boolean', required: false, unique: false },
    size: { type: 'choice', required: false, unique: false, options: { choices: [{ label: 'Small', value: 's' }, { label: 'Large', value: 'l' }], multiple: false } },
    tags: { type: 'choice', required: false, unique: false, options: { choices: [{ label: 'News', value: 'news' }, { label: 'Blog', value: 'blog' }], multiple: true } },
    gallery: { type: 'media', required: false, unique: false, single: false, options: { multiple: true } },
  },
}

registerEndpoint('/api/quarant/readMany', () => ({
  data: [
    { id: 1, title: 'Fine' },
    { id: 2, $quarantined: true },
  ],
  total: 2,
  page: 1,
  perPage: 25,
  quarantinedCount: 1,
}))
const quarantSchema = {
  name: 'quarant', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Item', plural: 'Items' },
  fields: { title: { type: 'text', required: true, unique: false } },
}

registerEndpoint('/api/clean/readMany', () => ({
  data: [{ id: 1, title: 'Fine' }], total: 1, page: 1, perPage: 25, quarantinedCount: 0,
}))
const cleanSchema = {
  name: 'clean', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Item', plural: 'Items' },
  fields: { title: { type: 'text', required: true, unique: false } },
}

// A localized-label collection with no rows, to assert the label map resolves (not "[object Object]").
registerEndpoint('/api/locthings/readMany', () => ({ data: [], total: 0, page: 1, perPage: 25 }))
const localizedSchema = {
  name: 'locthings', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: { en: 'Thing', de: 'Ding' }, plural: { en: 'Things', de: 'Dinge' } },
  fields: { title: { type: 'text', required: true, unique: false } },
}

// Fails while `failMode` is set, then succeeds — the test flips it before clicking Retry, so the result
// is deterministic regardless of how many times the component fetches on mount.
let failMode = true
registerEndpoint('/api/failing/readMany', () => {
  if (failMode) throw createError({ statusCode: 500, statusMessage: 'Boom' })
  return { data: [{ id: 1, title: 'Recovered' }], total: 1, page: 1, perPage: 25 }
})
const failingSchema = {
  name: 'failing', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Failing', plural: 'Failings' },
  fields: { title: { type: 'text', required: false, unique: false } },
}

// A choice column whose labels are per-language maps — what every built-in collection authors.
const choiceSchema = {
  name: 'things', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false }, label: { singular: 'Thing', plural: 'Things' },
  fields: {
    title: { type: 'text', required: true, translatable: false, unique: false },
    kind: {
      type: 'choice', required: false, translatable: false, unique: false,
      options: { choices: [{ label: { en: 'Permanent', de: 'Dauerhaft' }, value: 'p' }, { label: 'Plain', value: 'x' }] },
    },
  },
}

const mount = (props: Record<string, unknown>) => mountSuspended(CollectionList, { props })
const settle = async () => {
  await new Promise((r) => setTimeout(r, 20))
  await flushPromises()
}
// Past the 250ms value debounce AND the router navigation the commit triggers.
const committed = async () => {
  await new Promise((r) => setTimeout(r, 300))
  await flushPromises()
}
const findByText = (w: Awaited<ReturnType<typeof mount>>, sel: string, text: string) =>
  w.findAll(sel).find((b) => b.text().includes(text))!

describe('CollectionList', () => {
  // The component navigates the shared test router (list state lives in the URL), so reset the route
  // before each case or committed filter/sort/page would leak between tests.
  beforeEach(async () => {
    thingsBulk = null; statusBulk = null; customBulk = null; referrersQuery = {}; thingsFetches = 0; failReferrers = false; bulkDelayMs = 0
    await useRouter().replace({ path: '/', query: {} })
  })

  it('hides id by default, renders plain data cells (no smuggled link) and a real Edit anchor per row', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    // the identity-in-a-cell link is gone: every data cell is plain text
    expect(w.findAll('a.list__link').length).toBe(0)
    expect(w.text()).toContain('Alpha')
    expect(w.text()).toContain('Beta')
    expect(w.text()).toContain('New Thing')
    // id column is not shown by default
    expect(w.findAll('button.list__sort').some((b) => b.text().trim().startsWith('ID'))).toBe(false)
    // Edit is a real <a> into the editor (middle-click / open-in-new-tab / keyboard all work)
    const edit = w.findAll('tbody tr')[0]!.find('a.list__action-btn')
    expect(edit.exists()).toBe(true)
    expect(edit.attributes('href')).toBe('/admin/things/1')
    expect(w.find('a.list__new').attributes('href')).toBe('/admin/things/new')
  })

  it('places the row actions in their own cell right after Select, BEFORE the data cells (no right-edge overlay)', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const cells = w.findAll('tbody tr')[0]!.findAll('td')
    // col 0 = select checkbox, col 1 = row actions, THEN the data cells — so the actions can no longer
    // paint over the trailing Translations / dead-refs cells at the row's right edge.
    expect(cells[0]!.classes()).toContain('list__select-cell')
    expect(cells[0]!.find('input[type="checkbox"]').exists()).toBe(true)
    expect(cells[1]!.classes()).toContain('list__actions-cell')
    const edit = cells[1]!.find('a.list__action-btn')
    expect(edit.exists()).toBe(true)
    expect(edit.attributes('href')).toBe('/admin/things/1')
  })

  it('names the actions column with visually-hidden header text (not aria-label on a static th), placed after Select', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const headers = w.findAll('thead th')
    expect(headers[0]!.classes()).toContain('list__select-th')
    const actionsTh = headers[1]!
    expect(actionsTh.classes()).toContain('list__actions-th')
    expect(actionsTh.attributes('scope')).toBe('col')
    expect(actionsTh.attributes('aria-label')).toBeUndefined() // no aria-label on the static cell
    expect(actionsTh.find('.list__vh').text()).toBe('Actions') // real, announced header name
  })

  it('toggles sort on a header click and re-queries', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const titleHeader = findByText(w, 'button.list__sort', 'Title')
    await titleHeader.trigger('click')
    await settle()
    expect(lastQuery.sort).toBe('title')
    await titleHeader.trigger('click')
    await settle()
    expect(lastQuery.sort).toBe('-title')
  })

  it('advances the page', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const next = w.findAll('button').find((b) => b.text() === 'Next')!
    await next.trigger('click')
    await settle()
    expect(lastQuery.page).toBe('2')
  })

  it('lets the user enable a hidden column; uses the jsKey for a single relation (cell + sort)', async () => {
    const w = await mount({ schema: relSchema })
    await flushPromises()
    // author is a relation → hidden by default; enable it via the Columns panel
    await findByText(w, '.ui-button', 'Columns').trigger('click')
    await w.find('[data-col="authorId"]').setValue(true)
    await flushPromises()
    expect(w.text()).toContain('7') // cell renders row.authorId, not row.author
    const authorHeader = findByText(w, 'button.list__sort', 'Author')
    await authorHeader.trigger('click')
    await settle()
    expect(relQuery.sort).toBe('authorId')
  })

  it('closes an open toolbar panel on Escape', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    expect(w.find('#list-filter-panel').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.find('#list-filter-panel').exists()).toBe(false)
  })

  it('disables the last remaining column checkbox so a column always stays visible', async () => {
    const w = await mount({ schema: colsSchema }) // default visible: title, createdAt, updatedAt
    await flushPromises()
    await findByText(w, '.ui-button', 'Columns').trigger('click')
    await w.find('[data-col="createdAt"]').setValue(false)
    await w.find('[data-col="updatedAt"]').setValue(false)
    await flushPromises()
    expect(w.find('[data-col="title"]').attributes('disabled')).toBeDefined()
  })

  it('filters by the content locale and shows a locale switcher when a locale is set', async () => {
    const w = await mount({ schema: { ...thingsSchema, translatable: true }, locale: 'de' })
    await flushPromises()
    expect(lastQuery.locale).toBe('de')
    const switcher = w.find('.list__locales')
    expect(switcher.exists()).toBe(true)
    expect(switcher.find('.list__locale--active').text()).toBe('DE')
    expect(w.find('a.list__new').attributes('href')).toBe('/admin/things/new?locale=de')
    // the row's Edit action carries the locale so the editor opens in the same content locale
    expect(w.findAll('tbody tr')[0]!.find('a.list__action-btn').attributes('href')).toBe('/admin/things/1?locale=de')
  })

  it('renders per-row translation badges: present locales link to the sibling, missing ones offer create', async () => {
    const w = await mount({ schema: translSchema, locale: 'en' })
    await flushPromises()
    const rows = w.findAll('tbody tr')
    const r1de = rows[0]!.find('[data-loc="de"]')
    expect(r1de.exists()).toBe(true)
    expect(r1de.classes()).toContain('list__badge--present')
    expect(r1de.attributes('href')).toBe('/admin/transl/2?locale=de')
    const r2de = rows[1]!.find('[data-loc="de"]')
    expect(r2de.classes()).toContain('list__badge--missing')
    expect(r2de.attributes('href')).toBe('/admin/transl/new?locale=de&group=g3')
    expect(rows[1]!.find('[data-loc="en"]').classes()).toContain('list__badge--present')
  })

  it('renders an amber warning marker on rows with $hasDeadRefs and none on clean rows', async () => {
    const w = await mount({ schema: deadSchema })
    await flushPromises()
    const rows = w.findAll('tbody tr')
    expect(rows[0]!.find('.list__deadref-icon').exists()).toBe(true)
    expect(rows[1]!.find('.list__deadref-icon').exists()).toBe(false)
  })

  it('omits the locale query and switcher for a non-translatable list', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    expect(lastQuery.locale).toBeUndefined()
    expect(w.find('.list__locales').exists()).toBe(false)
  })

  it('applies an equality filter via the Filter panel, shows a chip, and resets to page 1', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const next = w.findAll('button').find((b) => b.text() === 'Next')!
    await next.trigger('click')
    await settle()
    expect(lastQuery.page).toBe('2')

    await findByText(w, '.ui-button', 'Filter').trigger('click')
    const titleFilter = w.find('input.list__filter[data-filter="title"]')
    expect(titleFilter.exists()).toBe(true)
    await titleFilter.setValue('Al')
    await new Promise((r) => setTimeout(r, 300)) // past the 250ms debounce
    await flushPromises()
    expect(lastQuery['filter[title]']).toBe('Al')
    expect(lastQuery.page).toBe('1')

    // an active filter shows as a removable chip
    const chip = w.find('.list__chip')
    expect(chip.exists()).toBe(true)
    await chip.find('.list__chip-x').trigger('click')
    await settle()
    expect(lastQuery['filter[title]']).toBeUndefined()
  })

  it('renders an operator select for multi-op columns and a typed value control per kind', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    // operator select present for datetime (createdAt) + text (title); absent for richtext (single op)
    expect(w.find('select.list__filter-op[data-filter-op="createdAt"]').exists()).toBe(true)
    expect(w.find('select.list__filter-op[data-filter-op="title"]').exists()).toBe(true)
    expect(w.find('select.list__filter-op[data-filter-op="body"]').exists()).toBe(false)
    // typed value controls: date for datetime, number for the id column, text for a text/richtext field
    expect(w.find('input[type="date"][data-filter="createdAt"]').exists()).toBe(true)
    expect(w.find('input[type="number"][data-filter="id"]').exists()).toBe(true)
    expect(w.find('input[type="text"][data-filter="title"]').exists()).toBe(true)
    expect(w.find('input[type="text"][data-filter="body"]').exists()).toBe(true)
  })

  it('renders a Yes/No select for a boolean field and an option list for a single choice', async () => {
    const w = await mount({ schema: typedSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    const boolCtl = w.find('select.list__filter[data-filter="active"]')
    expect(boolCtl.exists()).toBe(true)
    expect(boolCtl.text()).toContain('Yes')
    expect(boolCtl.text()).toContain('No')
    const enumCtl = w.find('select.list__filter[data-filter="size"]')
    expect(enumCtl.exists()).toBe(true)
    expect(enumCtl.text()).toContain('Small')
    expect(enumCtl.text()).toContain('Large')
  })

  it('renders a value <select> for a multi-choice (stringSet) field emitting the stored VALUE, not the label', async () => {
    const w = await mount({ schema: typedSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    // must be a value <select>, never the generic text box (typing the visible label would match nothing)
    const tagsCtl = w.find('select.list__filter[data-filter="tags"]')
    expect(tagsCtl.exists()).toBe(true)
    expect(w.find('input.list__filter[data-filter="tags"]').exists()).toBe(false)
    const opts = tagsCtl.findAll('option')
    expect(opts.map((o) => o.text())).toEqual(['—', 'News', 'Blog']) // labels shown to the user
    expect(opts.map((o) => o.attributes('value'))).toEqual(['', 'news', 'blog']) // stored values emitted
    // selecting a label commits the underlying VALUE token to the query (contains is the stringSet default op)
    await tagsCtl.setValue('news')
    await new Promise((r) => setTimeout(r, 300)) // past the 250ms debounce
    await flushPromises()
    expect(typedQuery['filter[tags][contains]']).toBe('news')
  })

  it('renders a number input for a many-relation/media (idSet) field, not the generic text box', async () => {
    const w = await mount({ schema: typedSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    expect(w.find('input[type="number"][data-filter="gallery"]').exists()).toBe(true)
    expect(w.find('input[type="text"][data-filter="gallery"]').exists()).toBe(false)
  })

  it('changing the operator re-queries with filter[field][op] (datetime gte)', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    const dateInput = w.find('input[type="date"][data-filter="createdAt"]')
    expect(dateInput.exists()).toBe(true)
    await dateInput.setValue('2026-03-01')
    const opSelect = w.find('select.list__filter-op[data-filter-op="createdAt"]')
    await opSelect.setValue('gte')
    await settle()
    expect(lastQuery['filter[createdAt][gte]']).toBe('2026-03-01')
    expect(lastQuery['filter[createdAt]']).toBeUndefined() // not the bare eq key
    expect(lastQuery.page).toBe('1')
  })

  it('sends a date clause exactly as the URL and the chips state it', async () => {
    // Whole-day semantics for a date-only value ("on or before D" covering D's later timestamps) belong to
    // the API — see filter-predicate.test.ts. Rewriting the operator here would only make the request
    // disagree with the address bar and the filter chip.
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    await w.find('input[type="date"][data-filter="createdAt"]').setValue('2026-03-01')
    const opSelect = w.find('select.list__filter-op[data-filter-op="createdAt"]')
    await opSelect.setValue('lte')
    await committed()
    expect(lastQuery['filter[createdAt][lte]']).toBe('2026-03-01')
    expect(lastQuery['filter[createdAt][lt]']).toBeUndefined()
    expect(w.find('.list__chip').text()).toContain('2026-03-01')
  })

  it('exposes sort state via aria-sort and hides the arrow glyph from AT (WCAG 1.3.1/4.1.2)', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const sortableThs = w.findAll('th').filter((th) => th.find('.list__sort').exists())
    expect(sortableThs.length).toBeGreaterThan(0)
    for (const th of sortableThs) expect(['ascending', 'descending', 'none']).toContain(th.attributes('aria-sort'))
    // the visual arrow indicator is hidden from assistive tech
    for (const b of w.findAll('.list__sort')) expect(b.find('span[aria-hidden="true"]').exists()).toBe(true)
    // sorting a column moves its aria-sort off 'none' (a header click navigates the URL, so let the
    // router replace settle before reading the derived aria-sort)
    await sortableThs[0]!.find('.list__sort').trigger('click')
    await settle()
    const sorted = w.findAll('th').filter((th) => th.find('.list__sort').exists())[0]!
    expect(['ascending', 'descending']).toContain(sorted.attributes('aria-sort'))
  })

  it('announces the result count in a polite status region (WCAG 4.1.3)', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const status = w.find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.text()).toContain('100') // total from the registered endpoint
  })

  it('surfaces a fetch error with Retry (no error boundary, no false empty state) and recovers on retry', async () => {
    failMode = true
    const w = await mount({ schema: failingSchema }) // initial fetch throws 500 — must not bubble to the boundary
    await settle()
    expect(w.find('.list__error').exists()).toBe(true)
    expect(w.find('.list__error').text()).toContain('Boom') // server statusMessage preferred
    expect(w.find('.ui-empty').exists()).toBe(false) // the "create your first" empty state is suppressed on error
    // retry → the endpoint now succeeds
    failMode = false
    await w.find('.list__retry').trigger('click')
    await settle()
    expect(w.find('.list__error').exists()).toBe(false)
    expect(w.text()).toContain('Recovered')
  })

  it('resolves a localized collection label (no "[object Object]"; uses the active language)', async () => {
    const w = await mount({ schema: localizedSchema })
    await flushPromises()
    // empty collection → the "New {label}" action renders; default admin language is en
    const newLink = w.find('.list__new')
    expect(newLink.exists()).toBe(true)
    expect(newLink.text()).toContain('Thing')
    expect(newLink.text()).not.toContain('[object Object]')
    expect(newLink.text()).not.toContain('locthings')
  })

  it('selects rows: header checkbox toggles the whole page, a partial selection is indeterminate', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const header = w.find('.list__select-th input[type="checkbox"]')
    const rowBoxes = w.findAll('.list__select-cell input[type="checkbox"]')
    expect(rowBoxes.length).toBe(2)
    // one row selected → header is indeterminate, not checked
    await rowBoxes[0]!.setValue(true)
    await flushPromises()
    expect((header.element as HTMLInputElement).indeterminate).toBe(true)
    expect((header.element as HTMLInputElement).checked).toBe(false)
    // select-all → every row checked, header checked and no longer indeterminate
    await header.setValue(true)
    await flushPromises()
    const boxes = w.findAll('.list__select-cell input[type="checkbox"]')
    expect(boxes.every((b) => (b.element as HTMLInputElement).checked)).toBe(true)
    expect((header.element as HTMLInputElement).indeterminate).toBe(false)
  })

  it('folds the selection count into the ONE permanent live region (first selection is not silent); no Publish without status', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    // The single polite live region is mounted from the start (announcing the result count). The bulk bar
    // is NOT itself a live region — toggling a pre-populated role=status node into the DOM would be silent
    // on the first selection, which is exactly when the feedback matters.
    const sr = w.find('.list__sr-status')
    expect(sr.attributes('role')).toBe('status')
    expect(sr.attributes('aria-live')).toBe('polite')
    expect(sr.text()).toContain('100') // result count while nothing is selected
    expect(w.find('.list__bulkbar').exists()).toBe(false)

    await w.findAll('.list__select-cell input[type="checkbox"]')[0]!.setValue(true)
    await flushPromises()
    const bar = w.find('.list__bulkbar')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('1')
    // the selection is announced by MUTATING the already-mounted region, not by inserting a new live node
    expect(w.find('.list__sr-status').text()).toContain('selected')
    expect(w.find('.list__sr-status').text()).toContain('1')
    // the bulk bar carries no competing live-region attributes
    expect(bar.attributes('role')).toBeUndefined()
    expect(bar.attributes('aria-live')).toBeUndefined()
    // status-less collection → no Publish/Unpublish
    expect(bar.findAll('.ui-button').some((b) => b.text() === 'Publish')).toBe(false)
  })

  it('offers Publish/Unpublish in the bulk bar only for a status collection, and posts publish', async () => {
    const w = await mount({ schema: statusSchema })
    await flushPromises()
    await w.find('.list__select-th input[type="checkbox"]').setValue(true)
    await flushPromises()
    const bar = w.find('.list__bulkbar')
    const publish = bar.findAll('.ui-button').find((b) => b.text() === 'Publish')
    const unpublish = bar.findAll('.ui-button').find((b) => b.text() === 'Unpublish')
    expect(publish).toBeTruthy()
    expect(unpublish).toBeTruthy()
    await publish!.trigger('click')
    await settle()
    expect(statusBulk).toEqual({ ids: [1, 2], patch: { status: 'published' } })
  })

  it('renders a schema-driven custom action in the bulk bar and posts {ids} to its own pipeline route', async () => {
    const confirmSpy = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirmSpy)
    const w = await mount({ schema: customSchema })
    await flushPromises()
    await w.find('.list__select-th input[type="checkbox"]').setValue(true)
    await flushPromises()
    const bar = w.find('.list__bulkbar')
    const archive = bar.find('[data-action="archive"]')
    expect(archive.exists()).toBe(true)
    expect(archive.text()).toBe('Archive') // ui.label from the wire, not the raw pipeline name
    await archive.trigger('click')
    await settle()
    expect(confirmSpy).toHaveBeenCalledOnce() // ui.confirm gates the run
    expect(customBulk).toEqual({ ids: [1, 2] })
    vi.unstubAllGlobals()
  })

  it('skips the custom action POST when the confirm prompt is declined', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))
    const w = await mount({ schema: customSchema })
    await flushPromises()
    await w.find('.list__select-th input[type="checkbox"]').setValue(true)
    await flushPromises()
    await w.find('.list__bulkbar [data-action="archive"]').trigger('click')
    await settle()
    expect(customBulk).toBeNull()
    vi.unstubAllGlobals()
  })

  it('row Delete opens the confirm dialog (fetching referrers); confirming posts the bulk delete + refetches', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const before = thingsFetches
    await w.findAll('tbody tr')[0]!.find('button.list__action-btn--danger').trigger('click')
    await settle()
    expect(referrersQuery.ids).toBe('1')
    expect(w.find('.ui-dialog__content').exists()).toBe(true)
    const confirm = w.findAll('.ui-dialog__content .ui-button').find((b) => /^delete$/i.test(b.text().trim()))!
    await confirm.trigger('click')
    await settle()
    expect(thingsBulk).toEqual({ ids: [1] })
    expect(thingsFetches).toBeGreaterThan(before)
  })

  it('when the referrer lookup fails, the dialog cautions (checked:false) instead of implying a safe delete', async () => {
    failReferrers = true
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await w.findAll('tbody tr')[0]!.find('button.list__action-btn--danger').trigger('click')
    await settle()
    // dialog still opens (a delete is never blocked on the warning lookup) …
    expect(w.find('.ui-dialog__content').exists()).toBe(true)
    // … but with the "references unverified" caution, NOT a plain safe-looking delete …
    expect(w.find('.collection-delete__caution').exists()).toBe(true)
    // … and no false "these are referenced" warning (referencedCount is 0 on a failed check)
    expect(w.find('.collection-delete__warn').exists()).toBe(false)
  })

  it('row Duplicate posts the bulk duplicate and refetches (no dialog)', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const before = thingsFetches
    const dup = w.findAll('tbody tr')[0]!.findAll('button.list__action-btn').find((b) => !b.classes().includes('list__action-btn--danger'))!
    await dup.trigger('click')
    await settle()
    expect(thingsBulk).toEqual({ ids: [1] })
    expect(thingsFetches).toBeGreaterThan(before)
  })

  it('disables the row Duplicate/Delete buttons while the batch op is in flight (no double-click)', async () => {
    bulkDelayMs = 50
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    const row = w.findAll('tbody tr')[0]!
    const dup = row.findAll('button.list__action-btn').find((b) => !b.classes().includes('list__action-btn--danger'))!
    const del = row.find('button.list__action-btn--danger')
    await dup.trigger('click')
    await flushPromises()
    expect(dup.attributes('disabled')).not.toBeUndefined()
    expect(del.attributes('disabled')).not.toBeUndefined()
    await new Promise((r) => setTimeout(r, 80))
    await flushPromises()
    const dupAfter = w.findAll('tbody tr')[0]!.findAll('button.list__action-btn').find((b) => !b.classes().includes('list__action-btn--danger'))!
    expect(dupAfter.attributes('disabled')).toBeUndefined()
  })

  it('seeds committed list state from the URL on mount (deep link): the fetch carries the filter + page and a chip renders', async () => {
    // mountSuspended replaces the route on mount (default '/'), so seed the deep link through its `route`
    // option rather than a pre-mount navigation (which the mount would clobber).
    const w = await mountSuspended(CollectionList, { props: { schema: thingsSchema }, route: { path: '/', query: { 'filter[title]': 'Al', page: '2' } } })
    await settle()
    // the initial fetch derives the committed state from the URL (sanitized), not from empty defaults
    expect(lastQuery['filter[title]']).toBe('Al')
    expect(lastQuery.page).toBe('2')
    // and the active-filter chip reflects the deep-linked clause
    const chip = w.find('.list__chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Al')
  })

  it('committing a filter keeps the Filter panel open (no remount): the panel node survives the navigation', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    expect(w.find('#list-filter-panel').exists()).toBe(true)
    const titleFilter = w.find('input.list__filter[data-filter="title"]')
    await titleFilter.setValue('Al')
    await new Promise((r) => setTimeout(r, 300)) // past the 250ms debounce → commitDrafts → setFilter navigates
    await settle()
    expect(lastQuery['filter[title]']).toBe('Al') // the commit landed
    // the panel is STILL mounted — the query change re-derives state in place instead of remounting
    expect(w.find('#list-filter-panel').exists()).toBe(true)
    // and the panel's draft resynced from the committed value (Back/Forward/deep-link parity)
    expect((w.find('input.list__filter[data-filter="title"]').element as HTMLInputElement).value).toBe('Al')
  })

  // The committed `filter` computed
  // returns a fresh object identity on EVERY route.query change (sort/page/perPage too). The draft-resync
  // watch must key on the filter's CONTENT, not that identity, so a sort/page navigation that touches no
  // filter clause leaves an in-progress panel edit intact.
  it('keeps an uncommitted draft operator across a sort navigation (does not reset it to the default)', async () => {
    const w = await mount({ schema: thingsSchema })
    await flushPromises()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    const opSelect = w.find('select.list__filter-op[data-filter-op="title"]')
    expect(opSelect.exists()).toBe(true)
    expect((opSelect.element as HTMLSelectElement).value).toBe('eq') // text default op; value still empty
    // Pick a different operator but leave the value empty → nothing is committed to the URL; the choice
    // lives only in the draft.
    await opSelect.setValue('contains')
    await settle()
    expect((w.find('select.list__filter-op[data-filter-op="title"]').element as HTMLSelectElement).value).toBe('contains')

    // A sort click recomputes the committed `filter` to a fresh-but-EMPTY object (identity flip, same content).
    await findByText(w, 'button.list__sort', 'Title').trigger('click')
    await settle()
    expect(lastQuery.sort).toBe('title') // the sort landed
    // The in-progress operator choice survives — it was NOT reverted to the default 'eq'.
    expect((w.find('select.list__filter-op[data-filter-op="title"]').element as HTMLSelectElement).value).toBe('contains')
  })
})

describe('CollectionList — quarantined rows', () => {
  it('renders a badge (icon + text, not color alone) on a quarantined row and none on a clean row', async () => {
    const w = await mount({ schema: quarantSchema })
    await flushPromises()
    const rows = w.findAll('tbody tr')
    const badge = rows[1]!.find('.list__quarantine-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.find('.ui-icon').exists()).toBe(true)
    expect(badge.text()).toContain('Quarantined')
    expect(rows[0]!.find('.list__quarantine-badge').exists()).toBe(false)
  })

  it('shows a count chip in the list header when quarantinedCount > 0', async () => {
    const w = await mount({ schema: quarantSchema })
    await flushPromises()
    const chip = w.find('.list__quarantine-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('1')
  })

  it('renders no count chip when quarantinedCount is 0', async () => {
    const w = await mount({ schema: cleanSchema })
    await flushPromises()
    expect(w.find('.list__quarantine-chip').exists()).toBe(false)
  })
})

describe('CollectionList — a choice filter with localized labels', () => {
  it('renders the label for the active language, not the raw `{ en, de }` map', async () => {
    const w = await mount({ schema: choiceSchema })
    await settle()
    await findByText(w, '.ui-button', 'Filter').trigger('click')
    await settle()
    const select = w.find('select.list__filter[data-filter="kind"]')
    expect(select.exists()).toBe(true)
    const texts = select.findAll('option').map((o) => o.text())
    expect(texts).toContain('Permanent')
    expect(texts).toContain('Plain')
    expect(texts.join(' ')).not.toContain('{')
  })
})
